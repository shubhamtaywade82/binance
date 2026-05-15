import os

SYMBOL = os.getenv("SYMBOL", "btcusdt")

WS_STREAMS = [
    f"{SYMBOL}@depth@100ms",
    f"{SYMBOL}@aggTrade",
    f"{SYMBOL}@bookTicker",
    f"{SYMBOL}@markPrice@1s",
]

API_KEY = os.getenv("BINANCE_API_KEY", "")
API_SECRET = os.getenv("BINANCE_API_SECRET", "")
BASE_URL = os.getenv("BINANCE_REST_BASE", "https://fapi.binance.com")

TRADE_THRESHOLD = float(os.getenv("ML_MIN_PROBABILITY", "0.65"))
MIN_EDGE_BPS = float(os.getenv("ML_MIN_EDGE_BPS", "8"))
MAX_POSITION = float(os.getenv("MAX_POSITION", "0.01"))
MAX_DAILY_LOSS = float(os.getenv("MAX_DAILY_LOSS", "0.03"))

MODEL_PATH = os.getenv("MODEL_PATH", "model_direction_30s.pkl")
FEATURE_DIR = os.getenv("ML_FEATURE_DIR", "../data/features")
