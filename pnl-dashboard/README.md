# PnL Dashboard

Paper trading performance dashboard — PostgreSQL persistence, FastAPI backend, Next.js frontend, Prometheus + Grafana monitoring.

## Architecture

```
┌──────────────┐     WS bridge      ┌──────────────┐
│  Trading Bot │────────────────────▶│  Vanilla JS  │  (existing UI, :5173)
│  (TypeScript) │                    │  Dashboard   │
│              │                    └──────────────┘
│  PaperWallet │──── PgWriter ─────▶┌──────────────┐
│  Adapter     │                    │  PostgreSQL  │  (:5432)
│  Prometheus  │──── /metrics ─────▶│  Prometheus  │  (:9091)
└──────────────┘                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │   Grafana    │  (:3001)
                                    └──────────────┘
                                    ┌──────────────┐
                                    │  FastAPI     │  (:8001)
                                    │  (reads PG)  │
                                    └──────┬───────┘
                                           │
                                    ┌──────▼───────┐
                                    │  Next.js     │  (:3002)
                                    │  Dashboard   │
                                    └──────────────┘
```

**The bot runs outside Docker** (it needs direct mainnet WebSocket access). Everything else runs in Docker Compose.

## Prerequisites

- Docker & Docker Compose
- Node.js 22+ (for the bot)
- The trading bot already set up (`npm install` done in the project root)

## Quick Start

### 1. Start infrastructure

```bash
docker compose up -d
```

This starts:

| Service    | URL                          | Credentials       |
|------------|------------------------------|--------------------|
| PostgreSQL | `localhost:5434`             | `postgres:postgres` (db: `bot`) |
| Prometheus | http://localhost:9091        | —                  |
| Grafana    | http://localhost:3001        | `admin` / `admin`  |
| FastAPI    | http://localhost:8001        | —                  |

The PostgreSQL schema is applied automatically on first start via `docker-entrypoint-initdb.d`.

### 2. Configure the bot

Add these to your `.env`:

```bash
# PostgreSQL persistence (writes trades, positions, equity to Postgres)
POSTGRES_URL=postgresql://postgres:postgres@localhost:5434/bot

# Prometheus metrics endpoint
PROMETHEUS_ENABLED=true
PROMETHEUS_PORT=9090

# Enhanced paper engine (optional)
PAPER_PARTIAL_FILLS=true
PAPER_MAX_SLIPPAGE_BPS=20
```

### 3. Run the bot

```bash
npm run dashboard
```

The bot will:
- Connect to Binance mainnet WebSockets for live market data
- Execute paper trades using the enhanced paper engine
- Write trades, positions, equity snapshots, and orders to PostgreSQL
- Expose Prometheus metrics on `:9090`
- Broadcast `paper_wallet`, `paper_position_update`, `paper_trade` messages over the dashboard WebSocket

### 4. Open the dashboards

| Dashboard         | URL                      | Purpose                                    |
|-------------------|--------------------------|--------------------------------------------|
| Existing UI       | http://localhost:5173    | Chart, signals, microstructure             |
| Next.js PnL       | http://localhost:3002    | Trades, positions, equity, analytics       |
| Grafana           | http://localhost:3001    | Infrastructure metrics, PnL gauges         |
| FastAPI (raw)     | http://localhost:8001    | REST API for trade/position/equity data    |
| FastAPI docs      | http://localhost:8001/docs | Interactive Swagger UI                   |

## Running the Next.js dashboard locally (dev mode)

If you prefer running the Next.js frontend outside Docker for development:

```bash
cd pnl-dashboard/frontend
npm install
npm run dev
```

Open http://localhost:3002. It reads from FastAPI at `http://localhost:8001` by default. Override with:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8001 npm run dev
```

## API Endpoints

| Method | Endpoint              | Description                              |
|--------|-----------------------|------------------------------------------|
| GET    | `/health`             | Health check                             |
| GET    | `/trades?limit=&offset=&symbol=&side=` | Paginated trade history   |
| GET    | `/trades/stats`       | Aggregate stats (PnL, win rate, profit factor) |
| GET    | `/positions`          | Open positions                           |
| GET    | `/wallet`             | Current wallet state                     |
| GET    | `/equity/curve?since=&limit=` | Equity time series for charts     |
| GET    | `/equity/latest`      | Latest equity snapshot                   |
| GET    | `/predictions?limit=&symbol=` | ML prediction log               |

## Prometheus Metrics

Available at `http://localhost:9090/metrics` (on the bot process):

| Metric                     | Type      | Description                    |
|----------------------------|-----------|--------------------------------|
| `bot_pnl_usdt`             | Gauge     | Total realized PnL             |
| `bot_equity_usdt`          | Gauge     | Current equity                 |
| `bot_drawdown_pct`         | Gauge     | Current drawdown fraction      |
| `bot_unrealized_pnl_usdt`  | Gauge     | Unrealized PnL                 |
| `bot_open_positions`       | Gauge     | Number of open positions       |
| `bot_trades_total`         | Counter   | Total trades (label: `side`)   |
| `bot_errors_total`         | Counter   | Total errors (label: `type`)   |
| `bot_order_latency_ms`     | Histogram | Order execution latency        |
| `bot_inference_latency_ms` | Histogram | ML inference latency           |
| `bot_slippage_bps`         | Histogram | Fill slippage in basis points  |

## Paper Engine Enhancements

### Enhanced Slippage Model

When `PAPER_PARTIAL_FILLS=true`, the slippage engine uses real-time book depth:

- Size impact scales by `quantity / topBookQty` instead of a flat constant
- Total slippage capped at `PAPER_MAX_SLIPPAGE_BPS` (default: 20 bps)
- Falls back to the original model when book depth is unavailable

### Live WS Broadcasts

The bot broadcasts these messages over the dashboard WebSocket:

| Message Type              | Frequency  | Content                                 |
|---------------------------|------------|-----------------------------------------|
| `paper_wallet`            | Every 2s   | Balance, equity, margin, PnL            |
| `paper_position_update`   | Every 2s   | All open positions with unrealized PnL  |
| `paper_trade`             | On close   | Closed trade details                    |

## Database

### Manual schema migration

If the database already exists (not a fresh start), apply the schema manually:

```bash
./pnl-dashboard/db/migrate.sh
```

Or with a custom connection:

```bash
POSTGRES_URL=postgresql://postgres:postgres@localhost:5434/bot ./pnl-dashboard/db/migrate.sh
```

### Reset data

```bash
docker compose down -v   # removes volumes (all data)
docker compose up -d     # fresh start with empty schema
```

## Stopping

```bash
# Stop infrastructure
docker compose down

# Stop with data cleanup
docker compose down -v
```

## File Structure

```
pnl-dashboard/
├── db/
│   ├── schema.sql          # PostgreSQL schema (5 tables)
│   └── migrate.sh          # Migration script
├── api/
│   ├── main.py             # FastAPI app
│   ├── db.py               # asyncpg pool
│   ├── routers/
│   │   ├── trades.py       # /trades endpoints
│   │   ├── positions.py    # /positions endpoint
│   │   ├── equity.py       # /equity endpoints
│   │   ├── wallet.py       # /wallet endpoint
│   │   └── predictions.py  # /predictions endpoint
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   ├── app/
│   │   ├── layout.tsx      # Dark theme shell + nav
│   │   ├── page.tsx        # Overview (PnL, equity curve, wallet)
│   │   ├── trades/page.tsx # Trade history table
│   │   ├── positions/page.tsx # Open positions
│   │   └── analytics/page.tsx # Win rate, drawdown, profit factor
│   ├── lib/api.ts          # SWR fetch helpers
│   ├── package.json
│   └── Dockerfile
├── prometheus.yml          # Prometheus scrape config
├── grafana/
│   ├── provisioning/       # Auto-configured datasource
│   └── dashboards/         # Pre-built trading dashboard
└── README.md               # This file

src/
├── persistence/pg-writer.ts      # Postgres writer (graceful degradation)
└── metrics/prometheus-exporter.ts # prom-client metrics server
```
