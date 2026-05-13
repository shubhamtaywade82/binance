import numpy as np
import joblib

FEATURE_ORDER = [
    "spread", "obi_5", "obi_10", "microprice",
    "trade_imbalance_1s", "ret_1m", "ret_5m",
    "vol_1m", "rv_1m", "rv_5m",
    "oi_delta_1m", "oi_zscore",
    "funding_zscore",
    "vol_regime_flag", "trend_strength",
]


class Model:
    def __init__(self, path: str = "model_direction_30s.pkl") -> None:
        self.clf = joblib.load(path)

    def predict(self, features: dict) -> dict:
        x = np.array([[features.get(f, 0.0) for f in FEATURE_ORDER]])
        probs = self.clf.predict_proba(x)[0]
        p = dict(zip(self.clf.classes_.tolist(), probs.tolist()))
        return {
            "p_down": p.get(-1, 0.0),
            "p_flat": p.get(0, 0.0),
            "p_up": p.get(1, 0.0),
        }
