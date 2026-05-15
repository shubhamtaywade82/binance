-- Migration: Fix positions table Primary Key
-- Symbol should be the unique identifier for a position in one-way mode.
-- This ensures upserts work correctly across bot restarts.

-- 1. Remove old constraints
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_pkey;

-- 2. Set symbol as Primary Key
ALTER TABLE positions ADD PRIMARY KEY (symbol);
