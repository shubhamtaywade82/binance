"""Export a trained LightGBM .pkl model to ONNX format with validation."""

import argparse
import sys
from pathlib import Path

import joblib
import numpy as np
import onnxmltools
from onnxmltools.convert.lightgbm.operator_converters.LightGbm import convert_lightgbm  # noqa: F401
from onnxconverter_common import FloatTensorType
import onnxruntime as ort


def export_onnx(pkl_path: str, onnx_path: str, n_features: int | None = None) -> None:
    print(f"Loading model from {pkl_path}")
    model = joblib.load(pkl_path)

    if n_features is None:
        n_features = model.n_features_
    print(f"  Feature count: {n_features}")

    initial_type = [("features", FloatTensorType([None, n_features]))]
    onnx_model = onnxmltools.convert_lightgbm(model, initial_types=initial_type)

    Path(onnx_path).parent.mkdir(parents=True, exist_ok=True)
    onnxmltools.utils.save_model(onnx_model, onnx_path)
    print(f"  ONNX model saved to {onnx_path}")

    validate(model, onnx_path, n_features)


def validate(lgb_model: object, onnx_path: str, n_features: int) -> None:
    print("Validating ONNX output matches LightGBM...")
    rng = np.random.default_rng(42)
    x_test = rng.standard_normal((10, n_features)).astype(np.float32)

    lgb_probs = lgb_model.predict_proba(x_test)  # type: ignore[attr-defined]

    sess = ort.InferenceSession(onnx_path)
    input_name = sess.get_inputs()[0].name
    onnx_result = sess.run(None, {input_name: x_test})
    onnx_probs = onnx_result[1]

    onnx_prob_array = np.array([[row[c] for c in sorted(row.keys())] for row in onnx_probs])

    max_diff = np.max(np.abs(lgb_probs - onnx_prob_array))
    print(f"  Max probability difference: {max_diff:.8f}")

    if max_diff < 1e-5:
        print("  PASS: ONNX output matches LightGBM.")
    else:
        print(f"  WARNING: Max diff {max_diff:.6f} exceeds 1e-5 tolerance.")
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export LightGBM .pkl to ONNX")
    parser.add_argument("--pkl", default="model_direction_30s.pkl", help="Path to trained .pkl model")
    parser.add_argument("--onnx", default="model_direction_30s.onnx", help="Output ONNX path")
    parser.add_argument("--n-features", type=int, default=None, help="Override feature count")
    args = parser.parse_args()

    export_onnx(args.pkl, args.onnx, args.n_features)


if __name__ == "__main__":
    main()
