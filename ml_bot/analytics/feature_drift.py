"""Feature drift report — compares training vs live feature distributions using PSI."""

from __future__ import annotations

import pandas as pd
import numpy as np

PSI_DRIFT_THRESHOLD = 0.2
PSI_BINS = 10
PSI_EPSILON = 1e-6


def _psi(expected: np.ndarray, actual: np.ndarray, bins: int = PSI_BINS) -> float:
    """Population Stability Index between two distributions."""
    breakpoints = np.linspace(
        min(expected.min(), actual.min()),
        max(expected.max(), actual.max()),
        bins + 1,
    )

    expected_pcts = np.histogram(expected, bins=breakpoints)[0] / len(expected) + PSI_EPSILON
    actual_pcts = np.histogram(actual, bins=breakpoints)[0] / len(actual) + PSI_EPSILON

    return float(np.sum((actual_pcts - expected_pcts) * np.log(actual_pcts / expected_pcts)))


def feature_drift_report(training_csv: str, live_csv: str) -> pd.DataFrame:
    """Per-feature: training mean/std vs live mean/std, PSI score, drift flag."""
    train_df = pd.read_csv(training_csv)
    live_df = pd.read_csv(live_csv)

    numeric_cols = [
        c for c in train_df.select_dtypes(include=[np.number]).columns
        if c in live_df.columns and c not in ("timestamp",)
    ]

    rows = []
    for col in numeric_cols:
        train_vals = train_df[col].dropna().values
        live_vals = live_df[col].dropna().values

        if len(train_vals) < PSI_BINS or len(live_vals) < PSI_BINS:
            continue

        psi_score = _psi(train_vals, live_vals)

        rows.append({
            "feature": col,
            "train_mean": float(np.mean(train_vals)),
            "train_std": float(np.std(train_vals)),
            "live_mean": float(np.mean(live_vals)),
            "live_std": float(np.std(live_vals)),
            "psi": psi_score,
            "drift": psi_score > PSI_DRIFT_THRESHOLD,
        })

    return pd.DataFrame(rows)


def print_drift_report(report: pd.DataFrame) -> None:
    """Formatted output of drift report."""
    if report.empty:
        print("No numeric features with enough data for drift analysis.")
        return

    drifted = report[report["drift"]]

    print("\n=== Feature Drift Report ===")
    print(f"Features analyzed: {len(report)}")
    print(f"Features drifted (PSI > {PSI_DRIFT_THRESHOLD}): {len(drifted)}")
    print()

    fmt = {
        "train_mean": "{:.6f}".format,
        "train_std": "{:.6f}".format,
        "live_mean": "{:.6f}".format,
        "live_std": "{:.6f}".format,
        "psi": "{:.4f}".format,
    }
    print(report.to_string(index=False, formatters=fmt))

    if not drifted.empty:
        print("\n*** DRIFTED FEATURES ***")
        print(drifted[["feature", "psi"]].to_string(index=False, float_format="%.4f"))
