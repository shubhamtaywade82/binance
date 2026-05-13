from config import TRADE_THRESHOLD, MIN_EDGE_BPS

TAKER_ROUND_BPS = 8


def decide(pred: dict, vol_1m: float) -> str:
    if pred["p_flat"] > 0.50:
        return "HOLD"
    if vol_1m > 0.002:
        return "HOLD"

    edge = max(pred["p_up"], pred["p_down"]) * MIN_EDGE_BPS
    if edge < TAKER_ROUND_BPS + MIN_EDGE_BPS:
        return "HOLD"

    if pred["p_up"] > TRADE_THRESHOLD:
        return "LONG"
    if pred["p_down"] > TRADE_THRESHOLD:
        return "SHORT"
    return "HOLD"
