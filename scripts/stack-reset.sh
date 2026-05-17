#!/usr/bin/env bash
# Wipe paper-trading runtime state. Safe to run while bot is stopped.
#
#   1. Postgres: DELETE FROM positions, trades, orders, equity_snapshots, events
#   2. Redis:    FLUSHDB
#   3. Local:    rm wallet.json, equity.jsonl, trades.csv
#
# Container service names are assumed: postgres, redis (from docker-compose.yml).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "[stack-reset] waiting for postgres health..."
for i in {1..30}; do
  if docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "[stack-reset] truncating Postgres tables..."
docker compose exec -T postgres psql -U postgres -d bot <<'SQL'
  TRUNCATE TABLE
    positions,
    trades,
    orders,
    equity_snapshots,
    events,
    predictions
  RESTART IDENTITY CASCADE;
SQL

echo "[stack-reset] flushing Redis DB..."
# Try docker redis first (port 6380 in compose), then fall back to host (6379).
if docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
  docker compose exec -T redis redis-cli FLUSHDB
fi
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli -p 6379 FLUSHDB >/dev/null 2>&1 || true
fi

echo "[stack-reset] removing local paper ledger files..."
rm -f "${REPO_ROOT}/paper/wallet.json" \
      "${REPO_ROOT}/paper/equity.jsonl" \
      "${REPO_ROOT}/paper/trades.csv" \
      "${REPO_ROOT}/paper/equity-curve.csv"

echo "[stack-reset] done. Wallet will reinitialise to PAPER_INITIAL_BALANCE_USDT on next boot."
