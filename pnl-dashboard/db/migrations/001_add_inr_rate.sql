-- 001_add_inr_rate.sql
-- Idempotent: adds the snapshot-time INR/USDT rate to equity_snapshots.
-- Safe to re-run; existing rows leave inr_per_usdt NULL.

ALTER TABLE equity_snapshots
    ADD COLUMN IF NOT EXISTS inr_per_usdt DOUBLE PRECISION;
