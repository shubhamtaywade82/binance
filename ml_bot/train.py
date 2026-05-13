"""Offline training script — load feature CSVs, build labels, train LightGBM, evaluate."""

import pandas as pd
import numpy as np
import lightgbm as lgb
import joblib
from pathlib import Path
from sklearn.metrics import classification_report

FEATURE_COLS = [
    "spread", "obi_5", "obi_10", "microprice", "book_pressure",
    "trade_imbalance_1s", "trade_imbalance_5s", "trade_imbalance_30s",
    "trade_intensity_1s", "ofi_cumulative",
    "rv_1s", "rv_5s", "rv_1m",
    "ret_1m", "ret_5m", "vol_1m",
    "candle_body_1m", "wick_ratio_upper_1m",
    "oi_delta_1m", "oi_zscore",
    "funding_zscore",
    "liquidation_volume_30s", "liquidation_side_bias_30s",
    "vol_regime_flag", "trend_strength",
]

THRESHOLD_BPS = 4
TAKER_FEE_BPS = 4
HORIZONS_SEC = [5, 30, 60]


def load_features(feature_dir: str = "../data/features") -> pd.DataFrame:
    p = Path(feature_dir)
    csvs = sorted(p.glob("features_*.csv"))
    if not csvs:
        raise FileNotFoundError(f"No feature CSVs found in {feature_dir}")
    dfs = [pd.read_csv(f) for f in csvs]
    df = pd.concat(dfs, ignore_index=True)
    df = df.sort_values("timestamp").reset_index(drop=True)
    return df


def build_labels(df: pd.DataFrame, horizon_sec: int = 30) -> pd.DataFrame:
    shift = horizon_sec
    df["future_return"] = (
        df["mid_price"].shift(-shift) - df["mid_price"]
    ) / df["mid_price"].replace(0, np.nan)

    threshold = THRESHOLD_BPS / 10_000

    def label_direction(x: float) -> int:
        if pd.isna(x):
            return 0
        if x > threshold:
            return 1
        if x < -threshold:
            return -1
        return 0

    df["y_direction"] = df["future_return"].apply(label_direction)
    df["tradeable"] = df["future_return"].abs() > TAKER_FEE_BPS * 2 / 10_000
    return df


def train(feature_dir: str = "../data/features", output: str = "model_direction_30s.pkl") -> None:
    print("Loading features...")
    df = load_features(feature_dir)
    print(f"  Loaded {len(df)} rows")

    print("Building labels...")
    df = build_labels(df, horizon_sec=30)

    available = [c for c in FEATURE_COLS if c in df.columns]
    missing = [c for c in FEATURE_COLS if c not in df.columns]
    if missing:
        print(f"  WARNING: Missing columns: {missing}")

    df = df[df["tradeable"]].dropna(subset=available + ["y_direction"])
    print(f"  Tradeable rows: {len(df)}")

    if len(df) < 100:
        print("ERROR: Not enough data to train. Collect more features first.")
        return

    split = int(len(df) * 0.8)
    X_train, X_val = df[available].iloc[:split], df[available].iloc[split:]
    y_train, y_val = df["y_direction"].iloc[:split], df["y_direction"].iloc[split:]

    print(f"  Train: {len(X_train)}, Val: {len(X_val)}")
    print(f"  Label distribution (train): {dict(y_train.value_counts())}")

    model = lgb.LGBMClassifier(
        n_estimators=1000,
        max_depth=6,
        learning_rate=0.02,
        num_leaves=63,
        subsample=0.8,
        colsample_bytree=0.8,
        class_weight="balanced",
        verbose=-1,
    )
    model.fit(
        X_train, y_train,
        eval_set=[(X_val, y_val)],
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(100)],
    )

    print("\nValidation Report:")
    print(classification_report(y_val, model.predict(X_val)))

    joblib.dump(model, output)
    print(f"\nModel saved to {output}")

    print("\nFeature importance (top 10):")
    imp = pd.Series(model.feature_importances_, index=available).sort_values(ascending=False)
    for feat, val in imp.head(10).items():
        print(f"  {feat}: {val}")


if __name__ == "__main__":
    train()
