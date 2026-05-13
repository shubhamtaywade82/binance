"""Build direction, volatility, and cost-adjusted labels from feature CSVs."""

import pandas as pd
import numpy as np
from pathlib import Path

THRESHOLD_BPS = 4
TAKER_FEE_BPS = 4
HORIZONS = [5, 30, 60]


def build_labels(df: pd.DataFrame) -> pd.DataFrame:
    threshold = THRESHOLD_BPS / 10_000

    for h in HORIZONS:
        col = f"future_return_{h}s"
        df[col] = (df["mid_price"].shift(-h) - df["mid_price"]) / df["mid_price"].replace(0, np.nan)

        def label_direction(x: float) -> int:
            if pd.isna(x):
                return 0
            if x > threshold:
                return 1
            if x < -threshold:
                return -1
            return 0

        df[f"y_{h}s"] = df[col].apply(label_direction)

    df["y_vol_30s"] = (
        df["mid_price"]
        .pct_change()
        .rolling(30)
        .std()
        .shift(-30)
    )

    df["tradeable"] = df["future_return_30s"].abs() > TAKER_FEE_BPS * 2 / 10_000

    return df


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

    for h in HORIZONS:
        counts = df[f"y_{h}s"].value_counts()
        print(f"\ny_{h}s distribution:")
        for label, count in sorted(counts.items()):
            print(f"  {label:+d}: {count} ({count / len(df) * 100:.1f}%)")

    tradeable_pct = df["tradeable"].sum() / len(df) * 100
    print(f"\nTradeable: {df['tradeable'].sum()} ({tradeable_pct:.1f}%)")

    df.to_csv(output, index=False)
    print(f"\nSaved labeled dataset to {output}")


if __name__ == "__main__":
    main()
