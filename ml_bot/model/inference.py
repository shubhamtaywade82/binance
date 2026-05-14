"""Inference wrapper — loads direction + volatility models and produces enriched predictions."""

from __future__ import annotations

import numpy as np
import joblib
from pathlib import Path

FEATURE_ORDER: list[str] = [
    "mid_price", "bid_price", "ask_price",
    "spread", "obi_5", "obi_10", "weighted_depth_imbalance", "microprice",
    "book_pressure", "spread_bps", "book_slope_bid", "book_slope_ask", "liquidity_gap",
    "trade_imbalance_1s", "trade_imbalance_5s", "trade_imbalance_30s", "trade_intensity_1s",
    "signed_volume_5s", "burstiness", "last_trade_direction_streak", "large_trade_flag",
    "ofi_cumulative", "rv_1s", "rv_5s", "rv_1m",
    "micro_bar_1s_close_ret", "micro_bar_1s_volume", "micro_bar_5s_close_ret", "micro_bar_5s_volume",
    "ret_1m", "ret_5m", "vol_1m", "candle_body_1m", "wick_ratio_upper_1m",
    "volume_zscore_1m", "range_expansion", "trend_slope", "momentum_5m",
    "oi", "oi_delta_1m", "oi_delta_5m", "oi_zscore", "oi_divergence", "oi_spike",
    "price_oi_regime",
    "funding_rate", "funding_zscore", "funding_extreme_flag", "mark_last_basis",
    "liquidation_volume_30s", "liquidation_side_bias_30s",
    "cancel_intensity", "book_thinning", "bid_wall_persistence", "ask_wall_persistence",
    "vol_regime_flag", "trend_strength",
]

REGIME_MAP: dict[int, str] = {0: "chop", 1: "trend", 2: "high_vol"}

_TREND_SLOPE_THRESH = 0.0003
_VOL_HIGH_THRESH = 0.002


def _classify_regime(features: dict) -> str:
    rv = abs(features.get("rv_1m", 0.0))
    ts = abs(features.get("trend_slope", 0.0))
    if rv > _VOL_HIGH_THRESH:
        return "high_vol"
    if ts > _TREND_SLOPE_THRESH:
        return "trend"
    return "chop"


def _try_load(path: str) -> object | None:
    p = Path(path)
    return joblib.load(p) if p.exists() else None


class Model:
    def __init__(
        self,
        direction_path: str = "model_direction_30s.pkl",
        vol_path: str = "model_vol_60s.pkl",
        fill_path: str = "model_fill_prob_30s.pkl",
        slippage_path: str = "model_slippage_30s.pkl",
        adverse_path: str = "model_adverse_move_30s.pkl",
    ) -> None:
        self.clf = joblib.load(direction_path)
        self.vol_model = _try_load(vol_path)
        self.fill_model = _try_load(fill_path)
        self.slippage_model = _try_load(slippage_path)
        self.adverse_model = _try_load(adverse_path)

    def predict(self, features: dict) -> dict:
        x = np.array([[features.get(f, 0.0) for f in FEATURE_ORDER]])

        probs = self.clf.predict_proba(x)[0]
        p = dict(zip(self.clf.classes_.tolist(), probs.tolist()))

        result: dict = {
            "p_down": p.get(-1, 0.0),
            "p_flat": p.get(0, 0.0),
            "p_up": p.get(1, 0.0),
            "regime": _classify_regime(features),
            "expected_volatility": float(self.vol_model.predict(x)[0]) if self.vol_model else None,
            "fill_probability": float(self.fill_model.predict_proba(x)[0][1]) if self.fill_model else None,
            "expected_slippage": float(self.slippage_model.predict(x)[0]) if self.slippage_model else None,
            "adverse_move_probability": float(self.adverse_model.predict_proba(x)[0][1]) if self.adverse_model else None,
        }

        return result
