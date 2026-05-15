"""Build multi-horizon direction, regression, volatility, regime, and cost-adjusted labels."""

from __future__ import annotations

import pandas as pd
import numpy as np
from pathlib import Path
from typing import Sequence

THRESHOLD_BPS: float = 4.0
TAKER_FEE_BPS: float = 4.0
SLIPPAGE_BPS: float = 1.0
HORIZONS_SEC: list[int] = [5, 30, 60, 300]
CLIP_BPS: float = 50.0

# Regime thresholds
TREND_SLOPE_THRESH: float = 0.0003
VOL_HIGH_THRESH: float = 0.002


# ---------------------------------------------------------------------------
# Core helpers
# ---------------------------------------------------------------------------

def _future_return(mid: pd.Series, horizon: int) -> pd.Series:
    """Raw forward return over *horizon* rows (1-second rows assumed)."""
    return (mid.shift(-horizon) - mid) / mid.replace(0, np.nan)


def _realized_vol(mid: pd.Series, horizon: int) -> pd.Series:
    """Forward-looking realized volatility: std of log-returns over next *horizon* rows."""
    log_ret = np.log(mid / mid.shift(1))
    return log_ret.shift(-horizon).rolling(horizon).std()


# ---------------------------------------------------------------------------
# 1. Direction labels (multi-horizon)
# ---------------------------------------------------------------------------

def _direction_labels(df: pd.DataFrame, horizons: Sequence[int], threshold_bps: float) -> pd.DataFrame:
    threshold = threshold_bps / 10_000
    for h in horizons:
        ret_col = f"y_return_{h}s"
        df[ret_col] = _future_return(df["mid_price"], h)

        df[f"y_direction_{h}s"] = np.select(
            [df[ret_col] > threshold, df[ret_col] < -threshold],
            [1, -1],
            default=0,
        )
    return df


# ---------------------------------------------------------------------------
# 2. Regression labels (clipped)
# ---------------------------------------------------------------------------

def _regression_labels(df: pd.DataFrame, horizons: Sequence[int], clip_bps: float) -> pd.DataFrame:
    clip_val = clip_bps / 10_000
    for h in horizons:
        ret_col = f"y_return_{h}s"
        if ret_col not in df.columns:
            df[ret_col] = _future_return(df["mid_price"], h)
        df[f"y_reg_{h}s"] = df[ret_col].clip(-clip_val, clip_val)
    return df


# ---------------------------------------------------------------------------
# 3. Volatility labels (forward-looking realized vol)
# ---------------------------------------------------------------------------

def _volatility_labels(df: pd.DataFrame, horizons: Sequence[int]) -> pd.DataFrame:
    for h in horizons:
        df[f"y_vol_{h}s"] = _realized_vol(df["mid_price"], h)
    return df


# ---------------------------------------------------------------------------
# 4. Regime labels (rule-based: 0=chop, 1=trend, 2=high-vol)
# ---------------------------------------------------------------------------

def _regime_labels(df: pd.DataFrame) -> pd.DataFrame:
    trend_slope = df.get("trend_slope", pd.Series(0.0, index=df.index))
    rv_1m = df.get("rv_1m", pd.Series(0.0, index=df.index))

    is_high_vol = rv_1m.abs() > VOL_HIGH_THRESH
    is_trend = trend_slope.abs() > TREND_SLOPE_THRESH

    df["label_regime"] = np.select(
        [is_high_vol, is_trend],
        [2, 1],
        default=0,
    )
    return df


# ---------------------------------------------------------------------------
# 5. Leakage guard
# ---------------------------------------------------------------------------

_LABEL_PREFIXES = ("y_", "label_", "tradeable", "future_return")

def validate_no_leakage(
    df: pd.DataFrame,
    feature_cols: Sequence[str],
    max_horizon: int,
) -> list[str]:
    """Return a list of violation messages if any feature column correlates
    suspiciously with future data beyond the label horizon.

    Checks:
      1. No feature column name matches a label prefix.
      2. For each feature, the cross-correlation with the *shifted* mid_price
         at lag = -max_horizon should be near zero.
    """
    violations: list[str] = []

    for col in feature_cols:
        if any(col.startswith(p) for p in _LABEL_PREFIXES):
            violations.append(f"Feature '{col}' has a label prefix — likely leakage")

    if "mid_price" in df.columns:
        future_mid = df["mid_price"].shift(-max_horizon)
        for col in feature_cols:
            if col not in df.columns:
                continue
            corr = df[col].corr(future_mid)
            if abs(corr) > 0.95:
                violations.append(
                    f"Feature '{col}' has {corr:.3f} correlation with mid_price "
                    f"shifted by -{max_horizon} — possible leakage"
                )

    return violations


# ---------------------------------------------------------------------------
# 6. Cost-adjusted labels
# ---------------------------------------------------------------------------

def _cost_adjusted_labels(
    df: pd.DataFrame,
    horizons: Sequence[int],
    taker_fee_bps: float,
    slippage_bps: float,
) -> pd.DataFrame:
    round_trip_cost = (taker_fee_bps + slippage_bps) * 2 / 10_000
    for h in horizons:
        ret_col = f"y_return_{h}s"
        if ret_col not in df.columns:
            continue
        net = df[ret_col].abs() - round_trip_cost
        df[f"y_tradeable_{h}s"] = net > 0
    return df


# ---------------------------------------------------------------------------
# 7. Execution quality labels (fill probability, slippage, adverse move)
# ---------------------------------------------------------------------------

def _execution_quality_labels(
    df: pd.DataFrame,
    horizons: Sequence[int],
    slippage_baseline_bps: float = 1.0,
) -> pd.DataFrame:
    """Build execution-focused labels from mid_price and spread.

    - ``y_fill_prob_{h}s``: Simulated fill probability — a limit order placed at
      the best bid/ask fills if price crosses within the horizon. Approximated as
      ``1`` when ``abs(future_return) > spread_bps / 2``, else ``0``.
    - ``y_slippage_bps_{h}s``: Estimated slippage — half the spread plus a
      volatility-scaled component. This is a *label* for training a slippage
      predictor, not a live estimate.
    - ``y_adverse_move_{h}s``: Probability proxy — ``1`` if price moves *against*
      the dominant direction by more than ``spread_bps`` within the horizon,
      else ``0``.
    """
    spread_bps = df.get("spread_bps", pd.Series(0.0, index=df.index))
    half_spread = spread_bps / 2 / 10_000

    for h in horizons:
        ret_col = f"y_return_{h}s"
        if ret_col not in df.columns:
            continue

        abs_ret = df[ret_col].abs()

        df[f"y_fill_prob_{h}s"] = (abs_ret > half_spread).astype(int)

        rv_col = df.get("rv_1m", pd.Series(0.0, index=df.index))
        df[f"y_slippage_bps_{h}s"] = (
            spread_bps / 2 + rv_col * 10_000 * slippage_baseline_bps
        ).clip(0, 50)

        future_high_col = f"_adverse_high_{h}s"
        future_low_col = f"_adverse_low_{h}s"

        rolling_high = df["mid_price"].shift(-1).rolling(h).max().shift(-(h - 1))
        rolling_low = df["mid_price"].shift(-1).rolling(h).min().shift(-(h - 1))

        mid = df["mid_price"].replace(0, np.nan)
        high_move = (rolling_high - mid) / mid
        low_move = (mid - rolling_low) / mid

        direction = df.get(f"y_direction_{h}s", pd.Series(0, index=df.index))
        adverse = np.where(
            direction >= 0,
            low_move > spread_bps / 10_000,
            high_move > spread_bps / 10_000,
        )
        df[f"y_adverse_move_{h}s"] = adverse.astype(int)

    return df


# ---------------------------------------------------------------------------
# 8. Public entry point — single-pass multi-horizon labeling
# ---------------------------------------------------------------------------

def build_labels(
    df: pd.DataFrame,
    horizons: Sequence[int] | None = None,
    threshold_bps: float = THRESHOLD_BPS,
    clip_bps: float = CLIP_BPS,
    taker_fee_bps: float = TAKER_FEE_BPS,
    slippage_bps: float = SLIPPAGE_BPS,
) -> pd.DataFrame:
    """Generate all label families from a single forward pass over *df*."""
    if horizons is None:
        horizons = HORIZONS_SEC

    df = _direction_labels(df, horizons, threshold_bps)
    df = _regression_labels(df, horizons, clip_bps)
    df = _volatility_labels(df, horizons)
    df = _regime_labels(df)
    df = _cost_adjusted_labels(df, horizons, taker_fee_bps, slippage_bps)
    df = _execution_quality_labels(df, horizons, slippage_bps)

    return df


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(feature_dir: str = "../data/features", output: str = "features_labeled.csv") -> None:
    p = Path(feature_dir)
    csvs = sorted(p.glob("features_*.csv"))
    if not csvs:
        print(f"No feature CSVs found in {feature_dir}")
        return

    dfs = [pd.read_csv(f) for f in csvs]
    df = pd.concat(dfs, ignore_index=True).sort_values("timestamp").reset_index(drop=True)
    print(f"Loaded {len(df)} feature rows from {len(csvs)} files")

    df = build_labels(df)

    # Leakage check
    feature_cols = [c for c in df.columns if not any(c.startswith(p) for p in _LABEL_PREFIXES)]
    violations = validate_no_leakage(df, feature_cols, max_horizon=max(HORIZONS_SEC))
    if violations:
        print("\n⚠ Leakage violations:")
        for v in violations:
            print(f"  - {v}")
    else:
        print("\nLeakage check passed.")

    for h in HORIZONS_SEC:
        counts = df[f"y_direction_{h}s"].value_counts()
        print(f"\ny_direction_{h}s distribution:")
        for label, count in sorted(counts.items()):
            print(f"  {label:+d}: {count} ({count / len(df) * 100:.1f}%)")

    for h in HORIZONS_SEC:
        tradeable_col = f"y_tradeable_{h}s"
        if tradeable_col in df.columns:
            n = df[tradeable_col].sum()
            print(f"Tradeable ({h}s): {n} ({n / len(df) * 100:.1f}%)")

    regime_counts = df["label_regime"].value_counts()
    regime_map = {0: "chop", 1: "trend", 2: "high-vol"}
    print("\nRegime distribution:")
    for label, count in sorted(regime_counts.items()):
        print(f"  {regime_map.get(label, label)}: {count} ({count / len(df) * 100:.1f}%)")

    df.to_csv(output, index=False)
    print(f"\nSaved labeled dataset to {output}")


if __name__ == "__main__":
    main()
