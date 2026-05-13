"""FastAPI inference server — serves model predictions to the TypeScript execution engine."""

from fastapi import FastAPI
import joblib
import numpy as np
from config import MODEL_PATH

app = FastAPI(title="ML Inference Server")

model = None

FEATURE_ORDER = [
    "spread", "obi_5", "obi_10", "microprice",
    "trade_imbalance_1s", "ret_1m", "ret_5m",
    "vol_1m", "rv_1m", "rv_5m",
    "oi_delta_1m", "oi_zscore",
    "funding_zscore",
    "vol_regime_flag", "trend_strength",
]


@app.on_event("startup")
def load_model() -> None:
    global model
    try:
        model = joblib.load(MODEL_PATH)
        print(f"Model loaded from {MODEL_PATH}")
    except FileNotFoundError:
        print(f"WARNING: Model file not found at {MODEL_PATH}. /infer will return defaults.")


@app.post("/infer")
def infer(body: dict) -> dict:
    if model is None:
        return {"p_down": 0.0, "p_flat": 1.0, "p_up": 0.0}

    features = body.get("features", {})
    x = np.array([[features.get(f, 0.0) for f in FEATURE_ORDER]])
    probs = model.predict_proba(x)[0]
    classes = model.classes_
    p = dict(zip(classes.tolist(), probs.tolist()))
    return {
        "p_down": p.get(-1, 0.0),
        "p_flat": p.get(0, 0.0),
        "p_up": p.get(1, 0.0),
    }


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "model_loaded": model is not None}
