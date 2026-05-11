# Binance data + CoinDCX execution

Standalone TypeScript worker: **Binance** public REST/WebSocket for signals, **CoinDCX** signed REST for futures orders (parity with `coindcx-bot` [`CoinDCXApi`](../coindcx-bot/src/gateways/coindcx-api.ts) — see [`src/coindcx/futures-client.ts`](src/coindcx/futures-client.ts)).

## Binance

- REST: USD-M futures klines (`/fapi/v1/klines`) or spot (`/api/v3/klines`) via `BINANCE_PRODUCT`.
- WebSocket: combined stream on `fstream.binance.com` (USDM) per [Binance Developers](https://developers.binance.com/docs). Some networks allow `fapi` HTTPS but not `fstream` push frames; the worker then uses **`USDM_MARK_REST_POLL_SEC`** (default 5s) to read the same mark from **`GET /fapi/v1/premiumIndex`** and logs `ltp_connected` with `source: mark_rest`.

## CoinDCX

- Environment variables match `coindcx-bot` (`API_BASE_URL`, `COINDCX_API_KEY`, `COINDCX_API_SECRET`, …).
- Default: `READ_ONLY=true`, `EXECUTION_ENABLED=false` — logs only.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev          # restarts on changes under src/
npm run dev:once     # single run, no file watcher
```

```bash
npm run check
```

## Symbol map

`BINANCE_SYMBOL` (e.g. `SOLUSDT`) must align with `COINDCX_PAIR` (e.g. `B-SOL_USDT`). Adjust both in `.env`.

## Strategy

Per LTF candle close:

1. **HTF bias** from 1h EMA(9/21) stack.
2. **LTF `analyzeTrend`** scoring 6 indicators — EMA fast vs slow, MACD hist sign+slope, RSI > 45 (long) / < 55 (short), Supertrend direction, swing structure HH+HL or LH+LL, volume ≥ 0.8× 20-bar avg. Direction set when ≥4 align AND volume confirms; `confidence = aligned/6`.
3. **SMC overlay** (`USE_SMC=true`) — liquidity sweep, order block (last opposite candle before ≥1.5×ATR impulse), 3-candle FVG, BOS/CHoCH from swings. `score` counts concepts agreeing with HTF.
4. Enter only when `htf.direction === ltf.direction !== 'NONE'` AND `confidence >= MIN_CONFIDENCE` AND `(!USE_SMC || smc.score >= MIN_SMC_SCORE)`.
5. Optional strict gate: `USE_SMC_CONFLUENCE=true` enforces weighted SMC confluence thresholds (standard/sniper).

## Risk math

- Margin = `CAPITAL_PER_TRADE_INR`. Notional USDT = `margin / INR_PER_USDT * LEVERAGE`. Quantity = floor-to-step(`notional / entry`).
- TP price move = `TARGET_PNL_PCT / LEVERAGE`; SL move = `STOP_LOSS_PCT / LEVERAGE`. At 10× a 1% price move = 10% PnL on margin.
- Net PnL USDT = `(exit-entry) * qty * dir - (entryNotional + exitNotional) * TAKER_FEE - entryNotional * FUNDING_FEE_EST`. INR via `INR_PER_USDT`.

## Modes

| Mode | `READ_ONLY` | `EXECUTION_ENABLED` | Behavior |
| ---- | ----------- | ------------------- | -------- |
| Paper (default) | `true` | `false` | Strategy fully evaluated, position tracked locally, CSV trade log written, no API writes. |
| Live | `false` | `true` | Sends create/exit/TP-SL/leverage updates to CoinDCX. |

## Execution Modes

`EXECUTION_MODE` selects the order-execution adapter. The strategy / `PositionManager` layer is adapter-agnostic.

| Value | Adapter | Side effects |
| ----- | ------- | ------------ |
| `paper` (default) | `PaperExecutionAdapter` | Simulated fills against Binance bookTicker (or synthetic mid from mark), wallet/PnL kept locally, JSONL ledger under `PAPER_LEDGER_DIR`. **No CoinDCX writes.** |
| `live` | `CoinDcxExecutionAdapter` | Real CoinDCX `create`, `tpsl`, `exit`, `update_leverage`. Requires `READ_ONLY=false` AND both API keys; throws at startup otherwise. |

### Paper engine components

- **`PaperWallet`** — balance / used margin / unrealized / realized; atomic `wallet.json` persistence.
- **`SlippageEngine`** — pure: `0.5*spread + 0.15*volPct + 1e-5*qty + bps/1e4`.
- **`computeFee` / fees** — taker/maker on notional.
- **`FundingEngine`** — polls `GET /fapi/v1/premiumIndex` every `PAPER_FUNDING_POLL_SEC`, charges open positions on each `nextFundingTime` crossing (idempotent).
- **`LiquidationEngine`** — `entry * (1 ∓ 1/lev ± maint)`; auto-closes via `onMark`.
- **`Ledger`** — append-only JSONL trades + equity snapshots.

### Paper output layout (`PAPER_LEDGER_DIR`, default `./paper`)

```text
paper/
├── wallet.json     # current wallet state (atomic write)
├── trades.jsonl    # one ClosedPosition per line
└── equity.jsonl    # periodic equity snapshots (PAPER_EQUITY_SNAPSHOT_SEC)
```

### Safety

Live execution requires **all three**: `EXECUTION_MODE=live` AND `READ_ONLY=false` AND non-empty `COINDCX_API_KEY` + `COINDCX_API_SECRET`. Missing any throws at startup. Default config (`paper`) is fully safe.

PostgreSQL persistence is deferred — JSONL ledger + atomic JSON wallet for now.

## Env reference

| Var | Default | Purpose |
| --- | ------- | ------- |
| `LEVERAGE` | `10` | Position leverage |
| `CAPITAL_PER_TRADE_INR` | `20000` | Margin per trade in INR |
| `INR_PER_USDT` | `85` | FX for sizing |
| `TARGET_PNL_PCT` / `STOP_LOSS_PCT` | `0.10` / `0.05` | TP/SL on margin |
| `MIN_CONFIDENCE` | `0.65` | Min trend confidence to enter |
| `MIN_SMC_SCORE` | `2` | Min SMC concepts agreeing |
| `USE_SMC` | `true` | Toggle SMC gate |
| `TAKER_FEE` / `MAKER_FEE` / `FUNDING_FEE_EST` | `0.0005` / `0.0002` / `0.0001` | Fee model |
| `MARGIN_CURRENCY` | `USDT` | Per CoinDCX field |
| `TRADE_LOG_PATH` | `./logs/trades.csv` | Per-trade audit CSV |
| `USDM_MARK_REST_POLL_SEC` | `5` | USD-M only: poll `premiumIndex` for mark/LTP; `0` = WebSocket only |

## Where logs go

- **Terminal:** every `log.info` / `log.warn` line is still printed to stdout/stderr.
- **Optional NDJSON file:** set `APP_LOG_PATH` (e.g. `./logs/app.ndjson`). Each line is one JSON object: `ts`, `level`, `msg`, plus any metadata fields.
- **Trades only:** closed trades are also appended to **`TRADE_LOG_PATH`** / `TRADES_CSV_PATH` as CSV (see `PositionManager`).
- **Heartbeat:** every `LOG_HEARTBEAT_SEC` (default 60) an `heartbeat` event is logged (and mirrored to the file when set).

## LTP (live price) check

Startup order:

1. **`binance_ws_connected`** — WebSocket is open.
2. **`ltp_connected`** — First live price arrived: **`mark`** (USD-M mark WebSocket), **`mark_rest`** (same mark from `GET /fapi/v1/premiumIndex` when WS is silent), or **`ticker`** (spot `24hrTicker` last price).
3. If nothing confirms LTP within **`LTP_CONNECT_WARN_SEC`** (default 15s), you get **`ltp_connect_timeout`**. With **`USDM_MARK_REST_POLL_SEC` > 0** (default 5), REST usually clears the watchdog even when `fstream` sends no `markPriceUpdate`. Set `LTP_CONNECT_WARN_SEC=0` to disable that warning.

Spot mode subscribes to `kline` + `@ticker` on the same combined stream so LTP uses the ticker’s last price.

## What you see while it runs

After seeding, the process stays open on the Binance WebSocket. Log lines (stdout):

| Event | Meaning |
| ------ | ------- |
| `runtime_help` | What to expect next (bar logs, signals, heartbeat). |
| `binance_ws_connected` | WS is up; streaming klines + mark (USDM) or klines + ticker (spot). |
| `ltp_connected` | First live price (`source`: `mark`, `mark_rest`, or `ticker`) — confirms LTP feed. |
| `ltp_connect_timeout` | No LTP within `LTP_CONNECT_WARN_SEC` after open/reconnect (REST poll disabled or `fapi` unreachable). |
| `usdm_mark_rest_failed` / `usdm_mark_rest_empty` | First REST poll failure or empty mark (then throttled). |
| `heartbeat` | Every `LOG_HEARTBEAT_SEC` seconds (default 60): last Binance mark, HTF/LTF EMA bias, aligned signal, bar counts. Set `LOG_HEARTBEAT_SEC=0` to disable. |
| `ltf_bar_closed` | Each **closed** LTF candle (e.g. every 15m): close, `htfBias` / `ltfBias`, `aligned` (would-trade direction if HTF/LTF agree). |
| `signal` / `paper_or_readonly_skip_order` | Only when the **aligned** signal **changes** from the previous value and is tradeable; paper mode logs intent instead of sending an order. |
| `binance_ws_reconnect` / `binance_ws_error` | Feed issues. |

So: if nothing changes for a long time, you should still see **`heartbeat`** once a minute and **`ltf_bar_closed`** every LTF interval.

## SOL 1.5% SMC confluence playbook

A formal strategy spec for multi-timeframe SMC confluence and 1.5% SOL capture is documented in [`docs/sol-1p5-smc-strategy.md`](docs/sol-1p5-smc-strategy.md).
