#!/usr/bin/env bash
# Reset paper-trading state: wipe ghost open positions (Redis + disk),
# reset wallet balance, clear marks. Realized PnL history in
# paper/trades.jsonl + paper/equity.jsonl is preserved.
#
# Use BEFORE restarting the bot after a cap-bypass incident or when
# you want a clean slate. Bot must be STOPPED first.
#
# Usage:
#   scripts/reset-paper-state.sh                  # confirm + reset
#   scripts/reset-paper-state.sh --force          # skip confirm
#   scripts/reset-paper-state.sh --balance 10000  # reset to specific USDT

set -euo pipefail

cd "$(dirname "$0")/.."

NS="${REDIS_NAMESPACE:-binance}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
BALANCE=""
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --balance) BALANCE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if pgrep -f "ts-node src/index.ts" >/dev/null; then
  echo "ERROR: bot still running (ts-node src/index.ts). Stop it first." >&2
  exit 1
fi

echo "Redis namespace: ${NS}"
echo "Redis URL:       ${REDIS_URL}"
echo "Will wipe:"
echo "  - ${NS}:paper:positions     (hash)"
echo "  - ${NS}:paper:wallet        (hash)"
echo "  - ${NS}:paper:last_marks    (hash)"
echo "  - ${NS}:paper:equity        (stream)"
echo "  - ./paper/wallet.json"
echo "  - ./paper/positions.json"
echo "Preserved: ./paper/trades.jsonl, ./paper/equity.jsonl"

if [[ $FORCE -ne 1 ]]; then
  read -r -p "Proceed? [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]] || { echo "aborted"; exit 0; }
fi

redis-cli -u "$REDIS_URL" <<EOF
DEL ${NS}:paper:positions
DEL ${NS}:paper:wallet
DEL ${NS}:paper:last_marks
DEL ${NS}:paper:equity
EOF

rm -f ./paper/wallet.json ./paper/positions.json

if [[ -n "$BALANCE" ]]; then
  mkdir -p ./paper
  cat > ./paper/wallet.json <<JSON
{
  "balanceUsdt": ${BALANCE},
  "availableUsdt": ${BALANCE},
  "usedMarginUsdt": 0,
  "unrealizedPnlUsdt": 0,
  "realizedPnlUsdt": 0,
  "equityUsdt": ${BALANCE},
  "updatedAt": $(date +%s%3N)
}
JSON
  echo "wallet.json seeded with balance=${BALANCE}"
fi

echo "done. Restart bot — RiskEngine will seed from empty paper adapter (clean)."
