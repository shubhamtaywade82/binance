"""Concept drift detection using Population Stability Index (PSI)."""

import numpy as np
import pandas as pd


def compute_psi(reference: pd.Series, current: pd.Series, bins: int = 10) -> float:
    """Compute PSI between a reference and current distribution."""
    breakpoints = np.linspace(0, 100, bins + 1)
    ref_clean = reference.dropna()
    cur_clean = current.dropna()

    if len(ref_clean) < bins or len(cur_clean) < bins:
        return 0.0

    edges = np.percentile(ref_clean, breakpoints)
    edges[0] = -np.inf
    edges[-1] = np.inf

    ref_counts = np.histogram(ref_clean, bins=edges)[0]
    cur_counts = np.histogram(cur_clean, bins=edges)[0]

    ref_pct = ref_counts / ref_counts.sum()
    cur_pct = cur_counts / cur_counts.sum()

    eps = 1e-6
    ref_pct = np.clip(ref_pct, eps, None)
    cur_pct = np.clip(cur_pct, eps, None)

    return float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))


class FeatureDriftDetector:
    """Monitors live feature distributions vs training baseline."""

    def __init__(self, bins: int = 10, threshold: float = 0.2) -> None:
        self.bins = bins
        self.threshold = threshold

    def check_drift(
        self, reference_df: pd.DataFrame, current_df: pd.DataFrame
    ) -> dict[str, float]:
        """Compute PSI per feature column shared between reference and current."""
        common_cols = [c for c in reference_df.columns if c in current_df.columns]
        scores: dict[str, float] = {}
        for col in common_cols:
            if not np.issubdtype(reference_df[col].dtype, np.number):
                continue
            scores[col] = compute_psi(reference_df[col], current_df[col], self.bins)
        return scores

    def is_drifted(
        self, psi_scores: dict[str, float], threshold: float | None = None
    ) -> list[str]:
        """Return feature names where PSI exceeds threshold."""
        th = threshold if threshold is not None else self.threshold
        return [feat for feat, psi in psi_scores.items() if psi > th]
