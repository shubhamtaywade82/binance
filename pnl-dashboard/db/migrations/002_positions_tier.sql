-- 002_positions_tier.sql
-- Adds an optional strategy-tier column to the positions table so the PnL
-- dashboard can render per-position tier ("scalp" / "swing") badges.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS tier TEXT;
