CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    ts BIGINT NOT NULL,
    source TEXT NOT NULL,
    symbol TEXT,
    payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_symbol ON events(symbol);
