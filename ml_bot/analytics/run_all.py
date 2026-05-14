"""Run all four analytics reports in sequence."""

from __future__ import annotations

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="Run all ML post-trade analytics reports")
    parser.add_argument("--predictions", required=True, help="Path to predictions CSV")
    parser.add_argument("--training-features", default=None, help="Path to training features CSV (for drift report)")
    parser.add_argument("--live-features", default=None, help="Path to live features CSV (for drift report)")
    parser.add_argument("--window-days", type=int, default=7, help="Window size in days for signal decay")
    args = parser.parse_args()

    from ml_bot.analytics.calibration import print_calibration_report
    from ml_bot.analytics.signal_decay import print_decay_report
    from ml_bot.analytics.pnl_attribution import print_pnl_attribution
    from ml_bot.analytics.feature_drift import feature_drift_report, print_drift_report

    print("=" * 60)
    print("        ML Post-Trade Analytics Suite")
    print("=" * 60)

    print("\n[1/4] Calibration Check")
    try:
        print_calibration_report(args.predictions)
    except Exception as e:
        print(f"  Error: {e}", file=sys.stderr)

    print("\n[2/4] Feature Drift Report")
    if args.training_features and args.live_features:
        try:
            report = feature_drift_report(args.training_features, args.live_features)
            print_drift_report(report)
        except Exception as e:
            print(f"  Error: {e}", file=sys.stderr)
    else:
        print("  Skipped — provide --training-features and --live-features")

    print(f"\n[3/4] Signal Decay (window={args.window_days}d)")
    try:
        print_decay_report(args.predictions, args.window_days)
    except Exception as e:
        print(f"  Error: {e}", file=sys.stderr)

    print("\n[4/4] PnL Attribution")
    try:
        print_pnl_attribution(args.predictions)
    except Exception as e:
        print(f"  Error: {e}", file=sys.stderr)

    print("\n" + "=" * 60)
    print("        Analytics complete")
    print("=" * 60)


if __name__ == "__main__":
    main()
