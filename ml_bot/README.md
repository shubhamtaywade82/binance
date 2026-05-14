# ML Bot — Python Inference & Training

Standalone Python process that runs alongside the TypeScript execution engine.
TypeScript owns execution + WebSocket ingestion; Python owns feature building, training, and inference.

## Setup

```bash
cd ml_bot
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Workflow

### 1. Collect training data (TypeScript side)

Set `ML_ENABLED=true` in `.env`. The TypeScript bot records normalized feature vectors
to `data/features/features_YYYY-MM-DD.csv` on every heartbeat.

### 2. Build labels

```bash
python label_builder.py
```

Reads feature CSVs from `../data/features/`, computes forward-looking direction labels
at 5s/30s/60s horizons, and writes `features_labeled.csv`.

### 3. Train model

```bash
python train.py
```

Trains a LightGBM direction classifier with walk-forward validation.
Outputs `model_direction_30s.pkl` and prints a classification report.

### 4. Start inference server

```bash
uvicorn inference_server:app --host 0.0.0.0 --port 8000
```

The TypeScript bot calls `POST /infer` with a feature vector and receives
`{ p_up, p_down, p_flat }` probabilities.

### 5. Enable ML gate (TypeScript side)

```env
ML_ENABLED=true
ML_SHADOW_MODE=false
ML_INFERENCE_URL=http://localhost:8000/infer
```

With `ML_SHADOW_MODE=true` (default), the bot logs ML predictions but doesn't
override SMC entry decisions. Set `false` to let the ML gate block entries
when the model doesn't confirm the signal.

## Standalone mode

The bot can also run as a fully standalone Python process:

```bash
python main.py
```

This connects directly to Binance WebSocket, builds features, runs inference,
and places orders via Binance REST. Requires a trained model and API credentials.

## Project structure

```
ml_bot/
├── config.py              # Environment config
├── main.py                # Standalone async event loop
├── train.py               # LightGBM training script
├── label_builder.py       # Direction/volatility label builder
├── inference_server.py    # FastAPI /infer endpoint
├── requirements.txt       # Python dependencies
├── ingestion/
│   └── ws_client.py       # WebSocket multiplexer
├── engine/
│   ├── orderbook.py       # L2 order book
│   └── features.py        # Rolling feature builder
├── model/
│   └── inference.py       # Model loader + predict
├── strategy/
│   ├── decision.py        # Threshold gate + regime filter
│   └── risk.py            # Position sizing + kill switch
└── execution/
    └── binance.py         # Signed REST client
```
