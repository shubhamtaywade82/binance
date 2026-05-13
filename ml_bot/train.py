"""Offline training — LightGBM direction classifier + volatility regressor,
SHAP analysis, and walk-forward validation."""

from __future__ import annotations

import pandas as pd
import numpy as np
import lightgbm as lgb
import joblib
import shap
from pathlib import Path
from sklearn.metrics import classification_report, mean_absolute_error, r2_score
from typing import Sequence

from label_builder import build_labels, validate_no_leakage, HORIZONS_SEC

# ---------------------------------------------------------------------------
# Full feature column set (matches FeatureVector schema)
# ---------------------------------------------------------------------------

FEATURE_COLS: list[str] = [
    "mid_price", "bid_price", "ask_price",
    "spread", "obi_5", "obi_10", "weighted_depth_imbalance", "microprice",
    "book_pressure", "spread_bps", "book_slope_bid", "book_slope_ask", "liquidity_gap",
    "trade_imbalance_1s", "trade_imbalance_5s", "trade_imbalance_30s", "trade_intensity_1s",
    "signed_volume_5s", "burstiness", "last_trade_direction_streak", "large_trade_flag",
    "ofi_cumulative", "rv_1s", "rv_5s", "rv_1m",
    "ret_1m", "ret_5m", "vol_1m", "candle_body_1m", "wick_ratio_upper_1m",
    "volume_zscore_1m", "range_expansion", "trend_slope", "momentum_5m",
    "oi", "oi_delta_1m", "oi_delta_5m", "oi_zscore", "oi_divergence", "oi_spike",
    "price_oi_regime",
    "funding_rate", "funding_zscore", "funding_extreme_flag", "mark_last_basis",
    "liquidation_volume_30s", "liquidation_side_bias_30s",
    "cancel_intensity", "book_thinning", "bid_wall_persistence", "ask_wall_persistence",
    "vol_regime_flag", "trend_strength",
]


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_features(feature_dir: str = "../data/features") -> pd.DataFrame:
    p = Path(feature_dir)
    csvs = sorted(p.glob("features_*.csv"))
    if not csvs:
        raise FileNotFoundError(f"No feature CSVs found in {feature_dir}")
    dfs = [pd.read_csv(f) for f in csvs]
    df = pd.concat(dfs, ignore_index=True).sort_values("timestamp").reset_index(drop=True)
    return df


def _available_features(df: pd.DataFrame) -> tuple[list[str], list[str]]:
    available = [c for c in FEATURE_COLS if c in df.columns]
    missing = [c for c in FEATURE_COLS if c not in df.columns]
    return available, missing


# ---------------------------------------------------------------------------
# LightGBM direction classifier
# ---------------------------------------------------------------------------

_DIR_PARAMS = dict(
    n_estimators=1000,
    max_depth=6,
    learning_rate=0.02,
    num_leaves=63,
    subsample=0.8,
    colsample_bytree=0.8,
    class_weight="balanced",
    verbose=-1,
)


def train_direction(
    df: pd.DataFrame,
    available: list[str],
    horizon: int = 30,
    output: str | None = None,
) -> lgb.LGBMClassifier | None:
    """Train a 3-class direction model for *horizon*-second labels."""
    y_col = f"y_direction_{horizon}s"
    tradeable_col = f"y_tradeable_{horizon}s"

    subset = df.copy()
    if tradeable_col in subset.columns:
        subset = subset[subset[tradeable_col]]
    subset = subset.dropna(subset=available + [y_col])

    if len(subset) < 200:
        print(f"  Not enough tradeable rows ({len(subset)}) for {horizon}s direction model.")
        return None

    split = int(len(subset) * 0.8)
    X_train, X_val = subset[available].iloc[:split], subset[available].iloc[split:]
    y_train, y_val = subset[y_col].iloc[:split], subset[y_col].iloc[split:]

    print(f"\n--- Direction {horizon}s ---")
    print(f"  Train: {len(X_train)}, Val: {len(X_val)}")
    print(f"  Label dist (train): {dict(y_train.value_counts())}")

    model = lgb.LGBMClassifier(**_DIR_PARAMS)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(100)],
    )

    print("\n  Validation report:")
    print(classification_report(y_val, model.predict(X_val), zero_division=0))

    if output:
        joblib.dump(model, output)
        print(f"  Saved to {output}")

    return model


# ---------------------------------------------------------------------------
# LightGBM volatility regressor
# ---------------------------------------------------------------------------

_VOL_PARAMS = dict(
    n_estimators=800,
    max_depth=5,
    learning_rate=0.03,
    num_leaves=31,
    subsample=0.8,
    colsample_bytree=0.8,
    verbose=-1,
)


def train_volatility(
    df: pd.DataFrame,
    available: list[str],
    horizon: int = 60,
    output: str | None = None,
) -> lgb.LGBMRegressor | None:
    """Train a regressor that predicts next-*horizon*-second realized vol."""
    y_col = f"y_vol_{horizon}s"

    subset = df.dropna(subset=available + [y_col])
    if len(subset) < 200:
        print(f"  Not enough rows ({len(subset)}) for {horizon}s vol model.")
        return None

    split = int(len(subset) * 0.8)
    X_train, X_val = subset[available].iloc[:split], subset[available].iloc[split:]
    y_train, y_val = subset[y_col].iloc[:split], subset[y_col].iloc[split:]

    print(f"\n--- Volatility {horizon}s ---")
    print(f"  Train: {len(X_train)}, Val: {len(X_val)}")

    model = lgb.LGBMRegressor(**_VOL_PARAMS)
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(100)],
    )

    preds = model.predict(X_val)
    mae = mean_absolute_error(y_val, preds)
    r2 = r2_score(y_val, preds)
    print(f"  MAE: {mae:.6f}, R²: {r2:.4f}")

    if output:
        joblib.dump(model, output)
        print(f"  Saved to {output}")

    return model


# ---------------------------------------------------------------------------
# SHAP analysis
# ---------------------------------------------------------------------------

def shap_analysis(
    model: lgb.LGBMClassifier | lgb.LGBMRegressor,
    X: pd.DataFrame,
    output_path: str | None = None,
    max_samples: int = 2000,
) -> pd.DataFrame:
    """Compute SHAP values and return a feature-importance DataFrame."""
    sample = X.sample(min(max_samples, len(X)), random_state=42)
    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(sample)

    if isinstance(shap_values, list):
        mean_abs = np.mean([np.abs(sv).mean(axis=0) for sv in shap_values], axis=0)
    else:
        mean_abs = np.abs(shap_values).mean(axis=0)

    importance = (
        pd.DataFrame({"feature": X.columns, "mean_abs_shap": mean_abs})
        .sort_values("mean_abs_shap", ascending=False)
        .reset_index(drop=True)
    )

    print("\n  SHAP importance (top 15):")
    for _, row in importance.head(15).iterrows():
        print(f"    {row['feature']}: {row['mean_abs_shap']:.6f}")

    if output_path:
        importance.to_csv(output_path, index=False)
        print(f"  SHAP importance saved to {output_path}")

    return importance


# ---------------------------------------------------------------------------
# Walk-forward validation
# ---------------------------------------------------------------------------

def walk_forward_validation(
    df: pd.DataFrame,
    available: list[str],
    horizon: int = 30,
    train_months: int = 3,
    test_months: int = 1,
) -> pd.DataFrame:
    """Rolling window train/test: train on *train_months*, test on next *test_months*."""
    y_col = f"y_direction_{horizon}s"
    tradeable_col = f"y_tradeable_{horizon}s"

    subset = df.copy()
    if tradeable_col in subset.columns:
        subset = subset[subset[tradeable_col]]
    subset = subset.dropna(subset=available + [y_col]).reset_index(drop=True)

    if "timestamp" not in subset.columns:
        print("  Walk-forward requires a 'timestamp' column.")
        return pd.DataFrame()

    subset["_ts"] = pd.to_datetime(subset["timestamp"], unit="ms", errors="coerce")
    if subset["_ts"].isna().all():
        subset["_ts"] = pd.to_datetime(subset["timestamp"], errors="coerce")

    subset = subset.sort_values("_ts").reset_index(drop=True)

    ts_min = subset["_ts"].min()
    ts_max = subset["_ts"].max()

    train_delta = pd.DateOffset(months=train_months)
    test_delta = pd.DateOffset(months=test_months)

    results: list[dict] = []
    fold = 0
    train_start = ts_min

    while train_start + train_delta + test_delta <= ts_max:
        train_end = train_start + train_delta
        test_end = train_end + test_delta

        tr = subset[(subset["_ts"] >= train_start) & (subset["_ts"] < train_end)]
        te = subset[(subset["_ts"] >= train_end) & (subset["_ts"] < test_end)]

        if len(tr) < 200 or len(te) < 50:
            train_start += test_delta
            continue

        model = lgb.LGBMClassifier(**_DIR_PARAMS)
        model.fit(tr[available], tr[y_col], verbose=-1)
        preds = model.predict(te[available])
        acc = (preds == te[y_col].values).mean()

        results.append({
            "fold": fold,
            "train_start": str(train_start.date()),
            "train_end": str(train_end.date()),
            "test_end": str(test_end.date()),
            "train_size": len(tr),
            "test_size": len(te),
            "accuracy": acc,
        })
        fold += 1
        train_start += test_delta

    result_df = pd.DataFrame(results)
    if not result_df.empty:
        print(f"\n--- Walk-forward ({horizon}s, {train_months}m/{test_months}m) ---")
        for _, row in result_df.iterrows():
            print(
                f"  Fold {row['fold']}: {row['train_start']}→{row['train_end']}→{row['test_end']}  "
                f"acc={row['accuracy']:.3f}  (train={row['train_size']}, test={row['test_size']})"
            )
        print(f"  Mean accuracy: {result_df['accuracy'].mean():.3f}")
    else:
        print("  Walk-forward: not enough data for any fold.")

    subset.drop(columns=["_ts"], inplace=True, errors="ignore")
    return result_df


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def train(
    feature_dir: str = "../data/features",
    direction_output: str = "model_direction_30s.pkl",
    vol_output: str = "model_vol_60s.pkl",
) -> None:
    print("Loading features...")
    df = load_features(feature_dir)
    print(f"  Loaded {len(df)} rows")

    print("Building labels...")
    df = build_labels(df)

    available, missing = _available_features(df)
    if missing:
        print(f"  WARNING: Missing feature columns ({len(missing)}): {missing[:10]}...")

    # Leakage guard
    violations = validate_no_leakage(df, available, max_horizon=max(HORIZONS_SEC))
    if violations:
        print("  LEAKAGE WARNINGS:")
        for v in violations:
            print(f"    - {v}")

    # --- Direction classifier (30s) ---
    dir_model = train_direction(df, available, horizon=30, output=direction_output)

    # --- Volatility regressor (60s) ---
    vol_model = train_volatility(df, available, horizon=60, output=vol_output)

    # --- SHAP for direction model ---
    if dir_model is not None:
        tradeable_col = "y_tradeable_30s"
        shap_subset = df.copy()
        if tradeable_col in shap_subset.columns:
            shap_subset = shap_subset[shap_subset[tradeable_col]]
        shap_subset = shap_subset.dropna(subset=available)
        if len(shap_subset) >= 100:
            shap_analysis(dir_model, shap_subset[available], output_path="shap_direction_30s.csv")

    # --- SHAP for volatility model ---
    if vol_model is not None:
        vol_shap_subset = df.dropna(subset=available)
        if len(vol_shap_subset) >= 100:
            shap_analysis(vol_model, vol_shap_subset[available], output_path="shap_vol_60s.csv")

    # --- Walk-forward ---
    walk_forward_validation(df, available, horizon=30, train_months=3, test_months=1)

    # --- Feature importance (built-in, quick) ---
    if dir_model is not None:
        print("\nLightGBM feature importance (top 15):")
        imp = pd.Series(dir_model.feature_importances_, index=available).sort_values(ascending=False)
        for feat, val in imp.head(15).items():
            print(f"  {feat}: {val}")


if __name__ == "__main__":
    train()
