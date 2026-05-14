"""FastAPI inference server — serves direction + volatility predictions to the TypeScript engine."""

from __future__ import annotations

from fastapi import FastAPI
import joblib
import numpy as np
from pathlib import Path
from config import MODEL_PATH

app = FastAPI(title="ML Inference Server")

direction_model = None
vol_model = None

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


@app.on_event("startup")
def load_models() -> None:
    global direction_model, vol_model
    try:
        direction_model = joblib.load(MODEL_PATH)
        print(f"Direction model loaded from {MODEL_PATH}")
    except FileNotFoundError:
        print(f"WARNING: Direction model not found at {MODEL_PATH}. /infer returns defaults.")

    vol_path = Path(MODEL_PATH).parent / "model_vol_60s.pkl"
    try:
        vol_model = joblib.load(vol_path)
        print(f"Volatility model loaded from {vol_path}")
    except FileNotFoundError:
        print(f"INFO: Volatility model not found at {vol_path}. expected_volatility will be null.")


@app.post("/infer")
def infer(body: dict) -> dict:
    features = body.get("features", {})
    x = np.array([[features.get(f, 0.0) for f in FEATURE_ORDER]])

    regime = _classify_regime(features)

    if direction_model is None:
        return {
            "p_down": 0.0,
            "p_flat": 1.0,
            "p_up": 0.0,
            "regime": regime,
            "expected_volatility": None,
        }

    probs = direction_model.predict_proba(x)[0]
    classes = direction_model.classes_
    p = dict(zip(classes.tolist(), probs.tolist()))

    expected_vol = None
    if vol_model is not None:
        expected_vol = float(vol_model.predict(x)[0])

    return {
        "p_down": p.get(-1, 0.0),
        "p_flat": p.get(0, 0.0),
        "p_up": p.get(1, 0.0),
        "regime": regime,
        "expected_volatility": expected_vol,
    }


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "direction_model_loaded": direction_model is not None,
        "vol_model_loaded": vol_model is not None,
    }
