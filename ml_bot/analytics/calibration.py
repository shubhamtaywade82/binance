"""Calibration check — bins predictions by p_up decile and compares to actual win rate."""

from __future__ import annotations

import pandas as pd
import numpy as np


def calibration_report(predictions_csv: str) -> pd.DataFrame:
    """Read prediction log CSV, bin by predicted p_up decile, compute actual win rate per bin."""
    df = pd.read_csv(predictions_csv)

    df = df.dropna(subset=["actual_direction"])
    if df.empty:
        return pd.DataFrame(columns=["decile", "predicted_p_up_mean", "actual_win_rate", "count"])

    df["win"] = (df["actual_direction"] == 1).astype(int)
    df["decile"] = pd.qcut(df["p_up"], q=10, duplicates="drop", labels=False)

    report = (
        df.groupby("decile")
        .agg(
            predicted_p_up_mean=("p_up", "mean"),
            actual_win_rate=("win", "mean"),
            count=("win", "size"),
        )
        .reset_index()
    )

    return report


def calibration_error(report: pd.DataFrame) -> float:
    """Mean absolute deviation between predicted p_up and actual win rate."""
    if report.empty:
        return 0.0

    return float(np.mean(np.abs(report["predicted_p_up_mean"] - report["actual_win_rate"])))


def print_calibration_report(predictions_csv: str) -> None:
    """Load, compute, and print the calibration report."""
    report = calibration_report(predictions_csv)
    if report.empty:
        print("No filled outcomes found — cannot compute calibration.")
        return

    error = calibration_error(report)

    print("\n=== Calibration Report ===")
    print(report.to_string(index=False, float_format="%.4f"))
    print(f"\nMean Absolute Calibration Error: {error:.4f}")
    if error < 0.05:
        print("Status: WELL CALIBRATED")
    elif error < 0.10:
        print("Status: ACCEPTABLE — minor miscalibration")
    else:
        print("Status: POORLY CALIBRATED — consider retraining")
