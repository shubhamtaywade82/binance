"""Signal decay tracking — rolling accuracy over time windows with trend detection."""

from __future__ import annotations

import pandas as pd
import numpy as np


def signal_decay_report(predictions_csv: str, window_days: int = 7) -> pd.DataFrame:
    """Rolling accuracy over time windows; detects accuracy trend."""
    df = pd.read_csv(predictions_csv)
    df = df.dropna(subset=["actual_direction"])
    if df.empty:
        return pd.DataFrame(columns=["window_start", "window_end", "accuracy", "count"])

    df["ts"] = pd.to_datetime(df["timestamp"], unit="ms")
    df["correct"] = (
        ((df["signal"] == "LONG") & (df["actual_direction"] == 1))
        | ((df["signal"] == "SHORT") & (df["actual_direction"] == -1))
    ).astype(int)

    df = df.sort_values("ts")
    df.set_index("ts", inplace=True)

    window_str = f"{window_days}D"

    window_starts = []
    window_ends = []
    accuracies = []
    counts = []

    groups = df.resample(window_str)
    for name, group in groups:
        if group.empty:
            continue
        window_starts.append(name)
        window_ends.append(group.index.max())
        accuracies.append(float(group["correct"].mean()))
        counts.append(len(group))

    return pd.DataFrame({
        "window_start": window_starts,
        "window_end": window_ends,
        "accuracy": accuracies,
        "count": counts,
    })


def is_decaying(report: pd.DataFrame, min_slope: float = -0.01) -> bool:
    """True if accuracy is trending downward (linear regression slope < min_slope)."""
    if len(report) < 3:
        return False

    y = report["accuracy"].values
    x = np.arange(len(y), dtype=float)

    x_mean = x.mean()
    y_mean = y.mean()
    slope = float(np.sum((x - x_mean) * (y - y_mean)) / np.sum((x - x_mean) ** 2))

    return slope < min_slope


def print_decay_report(predictions_csv: str, window_days: int = 7) -> None:
    """Load, compute, and print signal decay report."""
    report = signal_decay_report(predictions_csv, window_days)
    if report.empty:
        print("No filled outcomes — cannot compute signal decay.")
        return

    decaying = is_decaying(report)

    print(f"\n=== Signal Decay Report (window={window_days}d) ===")
    print(report.to_string(index=False, float_format="%.4f"))
    print(f"\nDecaying: {'YES — accuracy trending down' if decaying else 'NO — stable or improving'}")
