"""PnL attribution by model — splits realized PnL into signal, regime filter, and execution components."""

from __future__ import annotations

import pandas as pd
import numpy as np


def pnl_attribution(predictions_csv: str) -> dict:
    """Split realized PnL into signal_pnl, regime_filter_pnl, and execution_quality."""
    df = pd.read_csv(predictions_csv)
    df = df.dropna(subset=["actual_outcome"])
    if df.empty:
        return {"signal_pnl": 0.0, "regime_filter_pnl": 0.0, "execution_quality": 0.0}

    traded = df[df["signal"].isin(["LONG", "SHORT"])].copy()
    held = df[df["signal"] == "HOLD"].copy()

    signal_correct = traded.copy()
    signal_correct["direction_match"] = (
        ((signal_correct["signal"] == "LONG") & (signal_correct["actual_outcome"] > 0))
        | ((signal_correct["signal"] == "SHORT") & (signal_correct["actual_outcome"] < 0))
    )
    signal_pnl = float(
        traded.loc[signal_correct["direction_match"], "actual_outcome"].abs().sum()
        - traded.loc[~signal_correct["direction_match"], "actual_outcome"].abs().sum()
    )

    regime_filter_pnl = 0.0
    if not held.empty:
        avoided_losses = held.loc[held["actual_outcome"] < 0, "actual_outcome"]
        regime_filter_pnl = float(-avoided_losses.sum())

    execution_quality = 0.0
    if not traded.empty and "p_up" in traded.columns:
        expected_direction = np.where(traded["signal"] == "LONG", 1, -1)
        expected_magnitude = np.abs(np.maximum(traded["p_up"], traded["p_down"]) - 0.5) * 2
        expected_return = expected_direction * expected_magnitude * 0.001
        slippage = traded["actual_outcome"].values - expected_return
        execution_quality = float(np.mean(slippage))

    return {
        "signal_pnl": signal_pnl,
        "regime_filter_pnl": regime_filter_pnl,
        "execution_quality": execution_quality,
    }


def print_pnl_attribution(predictions_csv: str) -> None:
    """Load, compute, and print PnL attribution summary."""
    result = pnl_attribution(predictions_csv)

    print("\n=== PnL Attribution by Model ===")
    print(f"  Signal PnL:        {result['signal_pnl']:+.6f}")
    print(f"  Regime Filter PnL: {result['regime_filter_pnl']:+.6f}")
    print(f"  Execution Quality: {result['execution_quality']:+.6f}")

    total = result["signal_pnl"] + result["regime_filter_pnl"]
    print(f"\n  Net Model Value:   {total:+.6f}")
    if result["execution_quality"] < -0.0001:
        print("  Warning: execution slippage is significant — check fill quality")
