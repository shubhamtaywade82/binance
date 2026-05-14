"""Scheduled retraining — checks if retraining is due, trains, validates, and deploys."""

import logging
import time
from pathlib import Path

import numpy as np
import pandas as pd

from model_registry import ModelEntry, ModelRegistry
from train import FEATURE_COLS, build_labels, load_features

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

RETRAIN_INTERVAL_DAYS = 7


def should_retrain(last_train_ts: float, interval_days: int = RETRAIN_INTERVAL_DAYS) -> bool:
    elapsed_days = (time.time() - last_train_ts) / 86400
    return elapsed_days >= interval_days


def walk_forward_sharpe(
    df: pd.DataFrame, feature_cols: list[str], n_splits: int = 5
) -> float:
    """Walk-forward cross-validation returning average Sharpe ratio."""
    import lightgbm as lgb

    if len(df) < n_splits * 100:
        return 0.0

    fold_size = len(df) // (n_splits + 1)
    sharpes: list[float] = []

    for i in range(n_splits):
        train_end = fold_size * (i + 2)
        val_start = train_end
        val_end = min(train_end + fold_size, len(df))
        if val_end <= val_start:
            continue

        x_tr = df[feature_cols].iloc[:train_end]
        y_tr = df["y_direction"].iloc[:train_end]
        x_val = df[feature_cols].iloc[val_start:val_end]
        y_val = df["y_direction"].iloc[val_start:val_end]

        model = lgb.LGBMClassifier(
            n_estimators=500,
            max_depth=6,
            learning_rate=0.02,
            num_leaves=63,
            subsample=0.8,
            colsample_bytree=0.8,
            class_weight="balanced",
            verbose=-1,
        )
        model.fit(
            x_tr, y_tr,
            eval_set=[(x_val, y_val)],
            callbacks=[lgb.early_stopping(30), lgb.log_evaluation(0)],
        )

        preds = model.predict(x_val)
        returns = np.where(preds == y_val, np.abs(df["future_return"].iloc[val_start:val_end]), 0)
        returns = returns - np.where(preds != y_val, np.abs(df["future_return"].iloc[val_start:val_end]), 0)

        if len(returns) < 2 or np.std(returns) < 1e-12:
            sharpes.append(0.0)
        else:
            sharpes.append(float(np.mean(returns) / np.std(returns) * np.sqrt(252)))

    return float(np.mean(sharpes)) if sharpes else 0.0


def retrain_if_due(
    model_registry: ModelRegistry,
    feature_dir: str,
    min_sharpe: float = 0.5,
    interval_days: int = RETRAIN_INTERVAL_DAYS,
) -> bool:
    """Load newest data, train, validate, deploy if min Sharpe is met. Returns True if deployed."""
    active = model_registry.active_model()
    last_ts = active.created_at if active else 0.0

    if not should_retrain(last_ts, interval_days):
        logger.info("Retraining not due (last: %.0f, interval: %d days)", last_ts, interval_days)
        return False

    logger.info("Retraining triggered — loading features from %s", feature_dir)
    try:
        df = load_features(feature_dir)
    except FileNotFoundError:
        logger.warning("No feature data found in %s", feature_dir)
        return False

    df = build_labels(df, horizon_sec=30)
    available = [c for c in FEATURE_COLS if c in df.columns]
    df = df[df["tradeable"]].dropna(subset=available + ["y_direction"])

    if len(df) < 500:
        logger.warning("Insufficient data for retraining: %d rows", len(df))
        return False

    logger.info("Running walk-forward validation on %d rows", len(df))
    sharpe = walk_forward_sharpe(df, available)
    logger.info("Walk-forward Sharpe: %.3f (threshold: %.3f)", sharpe, min_sharpe)

    if sharpe < min_sharpe:
        logger.warning("Sharpe %.3f below minimum %.3f — skipping deployment", sharpe, min_sharpe)
        return False

    import joblib
    import lightgbm as lgb

    model = lgb.LGBMClassifier(
        n_estimators=1000,
        max_depth=6,
        learning_rate=0.02,
        num_leaves=63,
        subsample=0.8,
        colsample_bytree=0.8,
        class_weight="balanced",
        verbose=-1,
    )

    split = int(len(df) * 0.85)
    x_train, x_val = df[available].iloc[:split], df[available].iloc[split:]
    y_train, y_val = df["y_direction"].iloc[:split], df["y_direction"].iloc[split:]

    model.fit(
        x_train, y_train,
        eval_set=[(x_val, y_val)],
        callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)],
    )

    model_id = f"lgbm_{int(time.time())}"
    model_path = str(model_registry.registry_dir / f"{model_id}.pkl")
    joblib.dump(model, model_path)

    ts_col = df["timestamp"]
    entry = ModelEntry(
        model_id=model_id,
        file_path=model_path,
        train_start=str(ts_col.iloc[0]),
        train_end=str(ts_col.iloc[-1]),
        feature_schema_version=1,
        validation_metrics={"walk_forward_sharpe": sharpe, "n_rows": len(df)},
    )
    model_registry.register(entry)
    model_registry.activate(model_id)

    logger.info("Model %s deployed (Sharpe=%.3f, path=%s)", model_id, sharpe, model_path)
    return True
