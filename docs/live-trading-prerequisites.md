# Live Trading Prerequisites & Pre-flight Guide

Complete checklist before running the bot with real money on Binance USDT-M Futures.

---

## 1. Binance account requirements

| Requirement | How to verify |
|-------------|--------------|
| Futures trading **enabled** on your account | Binance → Profile → Enable Futures |
| Account KYC completed (identity verified) | Required for Futures access |
| Sufficient USDT in Futures wallet | At least `CAPITAL_PER_TRADE_USDT × 2` to cover margin + fees |
| Futures wallet funded (separate from Spot wallet) | Transfer USDT: Binance → Asset → Transfer → Spot → USDT-M Futures |

---

## 2. API key setup

### Create the key
1. Binance → Profile → API Management → Create API
2. Choose **HMAC-SHA256** key type (not Ed25519 — the live adapter uses HMAC)
3. Label it (e.g. `sol-futures-bot`)

### Permissions (minimum required)
| Permission | Required? |
|------------|-----------|
| **Enable Reading** | Yes |
| **Enable Futures** | Yes — mandatory |
| Enable Spot & Margin Trading | No |
| Enable Withdrawals | No — never grant this |

### Security
- **Restrict access by IP address** — add your server's static IP
- Store `BINANCE_API_KEY` and `BINANCE_API_SECRET` in `.env` (never commit to git)
- Use a dedicated key for this bot; do not share with other applications

---

## 3. Server / runtime requirements

| Requirement | Notes |
|-------------|-------|
| Node.js ≥ 20 | `node --version` |
| npm ≥ 9 | `npm --version` |
| Stable internet with **low latency to Binance** | Ideally in the same region as `fapi.binance.com` (Tokyo, Singapore, or Frankfurt) |
| **Static IP** (for API key restriction) | Dynamic IP will break API access after IP changes |
| System clock synchronized | NTP required — Binance rejects requests with timestamp skew > 1s |
| `./logs/` directory writable | Created automatically on first run |
| `./paper/` directory writable | Paper wallet ledger (created automatically) |

Verify NTP sync:
```bash
timedatectl status        # Linux
ntpq -p                   # check offset < 500ms
```

---

## 4. Environment configuration

### Step 1 — Copy the example
```bash
cp .env.example .env
```

### Step 2 — Testnet config (start here)

```env
# Execution
EXECUTION_MODE=live
READ_ONLY=false
PLACE_ORDER=true

# Binance live adapter
BINANCE_EXECUTION_ADAPTER=true
BINANCE_API_KEY=<your_testnet_api_key>
BINANCE_API_SECRET=<your_testnet_api_secret>
BINANCE_FUTURES_TESTNET=true

# Asset
TRADING_ASSET=sol

# Sizing (USDT-native, preferred)
CAPITAL_PER_TRADE_USDT=50
LEVERAGE=10

# TP/SL
TP_PRICE_PCT=0.015
SL_PRICE_PCT=0.010

# Logging
APP_LOG_PATH=./logs/app.ndjson
TRADE_LOG_PATH=./logs/trades.csv
LOG_HEARTBEAT_SEC=60
```

> **Testnet API keys are separate from mainnet.** Create them at:
> `https://testnet.binancefuture.com` → Login → API Management

### Step 3 — Mainnet config (after testnet validation)

Same as above, but:
```env
BINANCE_API_KEY=<your_mainnet_api_key>
BINANCE_API_SECRET=<your_mainnet_api_secret>
BINANCE_FUTURES_TESTNET=false
CAPITAL_PER_TRADE_USDT=200   # adjust to your risk tolerance
```

---

## 5. Pre-flight checklist

Run this before every live session:

```bash
npm run readiness:binance
```

Then manually verify:

- [ ] `.env` has `EXECUTION_MODE=live`, `READ_ONLY=false`, `PLACE_ORDER=true`
- [ ] `BINANCE_EXECUTION_ADAPTER=true`
- [ ] `BINANCE_API_KEY` and `BINANCE_API_SECRET` are set (non-empty)
- [ ] `BINANCE_FUTURES_TESTNET=false` (mainnet) or `true` (testnet — confirm intentionally)
- [ ] API key has **Futures** permission enabled on Binance
- [ ] API key is **IP-restricted** to your server's IP
- [ ] Server clock is NTP-synced (offset < 500ms)
- [ ] USDT Futures wallet has sufficient balance (`CAPITAL_PER_TRADE_USDT × 3` minimum)
- [ ] `./logs/` directory exists or is creatable
- [ ] No existing position open on the same symbol (or bot will restore it on startup)

---

## 6. Startup sequence

```bash
npm install          # first time only
npm run dev:once     # single run (recommended for first test)
# or
npm run dev          # hot-reload on code changes
```

### Expected log sequence on clean start

```
candles_seeded        { timeframes: ['5m','15m','1h','4h','1d'], nLtf: 500, nHtf: 500 }
instrument_precision  { source: 'binance_exchange_info', tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }
startup_no_open_position  { sym: 'SOLUSDT' }    ← or position_restored if one exists
orchestrator_started  { executionAdapter: 'binance', privateWs: true, ... }
binance_ws_connected  { wsBase: 'wss://fstream.binance.com', ... }
binance_private_ws_connected
ltp_connected         { source: 'mark', price: 145.23, ... }
heartbeat             { binanceMark: 145.23, ltpConfirmed: true, inPosition: false, ... }
```

If `ltp_connect_timeout` appears instead of `ltp_connected`, check network access to `fstream.binance.com`. The bot will still function via the REST mark poll (`USDM_MARK_REST_POLL_SEC=5`).

---

## 7. Order flow to verify on testnet

Place a trade manually to confirm the full pipeline:

1. Watch for `live_open` log — confirms MARKET entry filled
2. Watch for algo order IDs in `binance_order_placed` (`tp1`, `tp2`, `sl` fields)
3. On Binance testnet UI, confirm three algo orders visible for the symbol
4. Let price hit TP or SL
5. Watch for `binance_order_update` → `binance_exchange_close` → `position_closed (source: exchange)`
6. Confirm trade appended to `./logs/trades.csv`

---

## 8. Monitoring while running

| Signal | What to watch |
|--------|--------------|
| **Position open** | `live_open` log + `inPosition: true` in heartbeat |
| **TP/SL hit by exchange** | `binance_exchange_close` → `position_closed` with `source: exchange` |
| **Manual close triggered** | `exit_order_failed` (if any) + `position_closed` without `source: exchange` |
| **WS health** | `heartbeat.ltpConfirmed: true` every 60s; `binance_ws_reconnect` = connection issue |
| **Private WS health** | `binance_private_ws_connected` on start; `binance_private_ws_reconnect` = issue |
| **PnL** | `./logs/trades.csv` — one row per closed trade; `netUsdt` and `pctOnMargin` columns |

Stream logs in real-time:
```bash
tail -f logs/app.ndjson | jq .
```

Filter for closed trades only:
```bash
tail -f logs/app.ndjson | jq 'select(.msg == "position_closed")'
```

---

## 9. Emergency stop

### Graceful shutdown (preferred)
```bash
# Send SIGTERM to the process
kill <pid>
# or Ctrl+C if running in foreground
```

The bot will:
1. Stop the WebSocket feeds
2. Flush the paper wallet / ledger
3. Close the private WS and delete the listen key
4. Exit cleanly

### If the bot is unresponsive

Go to Binance directly:
1. **Cancel all open orders:** Binance Futures → Orders → Cancel All
2. **Close open position:** Binance Futures → Positions → Close (Market)
3. **Cancel algo orders:** Binance Futures → Orders → Algo Orders → Cancel All

The bot will detect the position is gone on next startup (startup reconciliation returns nothing) and start fresh.

### Force kill
```bash
kill -9 <pid>
```
No cleanup runs — cancel orders and close positions manually on Binance as above.

---

## 10. Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `INVALID_SIGNATURE` / `-1022` | Clock skew > 1s | Sync NTP: `sudo ntpdate -u pool.ntp.org` |
| `IP_BANNED` / `-2015` | API key not IP-restricted or wrong IP | Update API key IP whitelist on Binance |
| `No permission` / `-2014` | Futures not enabled on API key | Binance → API Management → Edit → Enable Futures |
| `binance_private_ws_start_failed` | Listen key creation failed (bad key or network) | Check API key permissions and network |
| `ltp_connect_timeout` | `fstream.binance.com` blocked by firewall/ISP | Check outbound WebSocket access; REST mark poll will compensate |
| `startup_reconcile_failed` | Network issue at boot | Bot continues without restored state; check open positions on Binance manually |
| `exit_order_failed: binance_close_unknown` | Position was already closed by exchange TP/SL before bot-side SL triggered | Normal race — exchange win is correct behavior, no action needed |
| Algo orders not visible on Binance | `placeAlgoOrder` failed silently | Check `binance_tp1_warn` / `binance_sl_warn` logs; verify Futures account has no restrictions |

---

## 11. Risk settings reference

| Use case | Suggested starting values |
|----------|--------------------------|
| Testnet validation | `CAPITAL_PER_TRADE_USDT=50`, `LEVERAGE=10` |
| Conservative live | `CAPITAL_PER_TRADE_USDT=100`, `LEVERAGE=10` |
| Standard (1.5% playbook) | `CAPITAL_PER_TRADE_USDT=200`, `LEVERAGE=10` |
| Max recommended | `CAPITAL_PER_TRADE_USDT=500`, `LEVERAGE=10` |

Never exceed a position size where the SL loss (`CAPITAL_PER_TRADE_USDT × SL_PRICE_PCT × LEVERAGE`) would be more than 2% of your total futures wallet balance.

---

## 12. File layout at runtime

```
./
├── .env                    # credentials + config (never commit)
├── logs/
│   ├── app.ndjson          # structured log (one JSON per line)
│   └── trades.csv          # closed trades audit trail
└── paper/                  # only used in paper mode
    ├── wallet.json
    ├── trades.jsonl
    └── equity.jsonl
```
