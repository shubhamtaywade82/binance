-- PnL Dashboard Schema
-- Run: psql -U postgres -d bot -f schema.sql

CREATE TABLE IF NOT EXISTS trades (
    id              SERIAL PRIMARY KEY,
    order_id        TEXT UNIQUE NOT NULL,
    timestamp_ms    BIGINT NOT NULL,
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL,
    leverage        INTEGER,
    qty             DOUBLE PRECISION NOT NULL,
    entry_price     DOUBLE PRECISION NOT NULL,
    exit_price      DOUBLE PRECISION NOT NULL,
    gross_pnl       DOUBLE PRECISION NOT NULL,
    fees            DOUBLE PRECISION NOT NULL,
    funding         DOUBLE PRECISION NOT NULL,
    net_pnl         DOUBLE PRECISION NOT NULL,
    close_reason    TEXT,
    opened_at       BIGINT NOT NULL,
    closed_at       BIGINT NOT NULL,
    attribution     JSONB
);

CREATE TABLE IF NOT EXISTS positions (
    order_id        TEXT PRIMARY KEY,
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL,
    qty             DOUBLE PRECISION NOT NULL,
    entry_price     DOUBLE PRECISION NOT NULL,
    leverage        INTEGER NOT NULL,
    margin_usdt     DOUBLE PRECISION NOT NULL,
    unrealized_pnl  DOUBLE PRECISION NOT NULL DEFAULT 0,
    liq_price       DOUBLE PRECISION,
    opened_at       BIGINT NOT NULL,
    updated_at      BIGINT NOT NULL,
    tier            TEXT
);

CREATE TABLE IF NOT EXISTS equity_snapshots (
    ts              BIGINT PRIMARY KEY,
    balance         DOUBLE PRECISION NOT NULL,
    equity          DOUBLE PRECISION NOT NULL,
    used_margin     DOUBLE PRECISION NOT NULL,
    unrealized_pnl  DOUBLE PRECISION NOT NULL,
    realized_pnl    DOUBLE PRECISION NOT NULL,
    drawdown        DOUBLE PRECISION NOT NULL,
    open_positions  INTEGER NOT NULL,
    inr_per_usdt    DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS orders (
    id              SERIAL PRIMARY KEY,
    order_id        TEXT NOT NULL,
    timestamp_ms    BIGINT NOT NULL,
    symbol          TEXT NOT NULL,
    side            TEXT NOT NULL,
    qty             DOUBLE PRECISION NOT NULL,
    price           DOUBLE PRECISION NOT NULL,
    status          TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'MARKET',
    fill_price      DOUBLE PRECISION,
    fee_usdt        DOUBLE PRECISION,
    slippage_usdt   DOUBLE PRECISION,
    latency_ms      DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS predictions (
    id              SERIAL PRIMARY KEY,
    timestamp_ms    BIGINT NOT NULL,
    symbol          TEXT NOT NULL,
    p_up            DOUBLE PRECISION NOT NULL,
    p_down          DOUBLE PRECISION NOT NULL,
    regime          TEXT,
    signal          TEXT,
    actual_outcome  INTEGER
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades (timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades (symbol);
CREATE INDEX IF NOT EXISTS idx_equity_ts ON equity_snapshots (ts DESC);
CREATE INDEX IF NOT EXISTS idx_orders_timestamp ON orders (timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders (order_id);
CREATE INDEX IF NOT EXISTS idx_predictions_timestamp ON predictions (timestamp_ms DESC);
