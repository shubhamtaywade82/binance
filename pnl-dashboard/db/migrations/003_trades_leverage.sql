-- Closed-trade leverage (per position at entry). Nullable for rows inserted before this column existed.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS leverage INTEGER;
