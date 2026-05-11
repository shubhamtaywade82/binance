# Binance data + CoinDCX execution

Standalone TypeScript worker: **Binance** public REST/WebSocket for signals, **CoinDCX** signed REST for futures orders (parity with `coindcx-bot` [`CoinDCXApi`](../coindcx-bot/src/gateways/coindcx-api.ts) — see [`src/coindcx/futures-client.ts`](src/coindcx/futures-client.ts)).

## Binance (USD-M Futures derivatives)

Official reference: [Derivatives](https://developers.binance.com/docs/derivatives), especially [USDⓈ-M Futures general info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info) and [WebSocket market streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams). **Algo (TWAP/VP):** [Algo Trading](https://developers.binance.com/docs/algo).  
**In-repo map (market data → WS → orders → account → algo):** [docs/binance-usdm-perpetual-reference.md](docs/binance-usdm-perpetual-reference.md).

- REST: USD-M on **`https://fapi.binance.com`** (`/fapi/v1/klines`, `/fapi/v1/depth`, `/fapi/v1/premiumIndex`, …). Testnet default when **`BINANCE_FUTURES_TESTNET=true`**: **`https://demo-fapi.binance.com`** (still override with **`BINANCE_REST_BASE`** if needed).
- WebSocket: Per Binance’s **Public / Market** split, this repo opens **two** connections from the root host **`BINANCE_WS_BASE`** (default **`wss://fstream.binance.com`**): **`…/market/stream`** for klines, agg trades, mark price; **`…/public/stream`** for book ticker and depth. Testnet WS root default: **`wss://fstream.binancefuture.com`**. Do not point `BINANCE_WS_BASE` at a single routed path unless you know what you’re doing—the normalizer strips a trailing `/market` or `/public` back to the root.

### Binance USD-M WebSocket **trading** API (`ws-fapi`)

For **`session.logon`**, **`order.place`**, etc., Binance uses a **different** WebSocket: **`wss://ws-fapi.binance.com/ws-fapi/v1`** (testnet: **`wss://testnet.binancefuture.com/ws-fapi/v1`**). Signing uses **Ed25519** only ([docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-api-general-info)).

This repo includes **`BinanceFuturesWsApiClient`** (`src/binance/futures-ws-api.ts`) and optional wiring via **`tryCreateBinanceFapiWsClient`** (`src/binance/create-futures-ws-api.ts`). It does **not** replace CoinDCX execution unless you integrate it yourself.

Quick check (after enabling env vars + PEM path):

```bash
npm run fapi:ws:status
```
- Some networks allow `fapi` HTTPS but not `fstream` push frames; the worker then uses **`USDM_MARK_REST_POLL_SEC`** (default 5s) to read the same mark from **`GET /fapi/v1/premiumIndex`** and logs `ltp_connected` with `source: mark_rest`.

## CoinDCX

- Environment variables match `coindcx-bot` (`API_BASE_URL`, `COINDCX_API_KEY`, `COINDCX_API_SECRET`, …).
- Default: **`PLACE_ORDER=false`** — strategy runs and logs signals; **no orders** (paper or live). Set **`PLACE_ORDER=true`** to allow `PositionManager` to call the execution adapter. Defaults also include `READ_ONLY=true` (CoinDCX REST writes blocked at the client).

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

## Trading asset (single knob)

Set **`TRADING_ASSET=sol`** | **`eth`** | **`btc`** — the app fills **`BINANCE_SYMBOL`** (USD-M on Binance) and **`COINDCX_PAIR`** from presets in [`src/config/asset-presets.ts`](src/config/asset-presets.ts). Use **`TRADING_ASSET=custom`** only if you set both symbols manually in `.env`.

Defaults include **`BINANCE_TIMEFRAMES=5m,15m,1h,4h,1d`**, **`USE_SOL_MTF_STRATEGY=true`** (multi-timeframe SMC stack), **`TP_PRICE_PCT=0.015`**, **`SL_PRICE_PCT=0.01`**, **`APP_LOG_PATH=./logs/app.ndjson`** — override only when needed.

## Strategy

Per LTF candle close:

1. **HTF bias** from 1h EMA(9/21) stack.
2. **LTF `analyzeTrend`** scoring 6 indicators — EMA fast vs slow, MACD hist sign+slope, RSI > 45 (long) / < 55 (short), Supertrend direction, swing structure HH+HL or LH+LL, volume ≥ 0.8× 20-bar avg. Direction set when ≥4 align AND volume confirms; `confidence = aligned/6`.
3. **SMC overlay** (`USE_SMC=true`) — liquidity sweep, order block (last opposite candle before ≥1.5×ATR impulse), 3-candle FVG, BOS/CHoCH from swings. `score` counts concepts agreeing with HTF.
4. Enter only when `htf.direction === ltf.direction !== 'NONE'` AND `confidence >= MIN_CONFIDENCE` AND `(!USE_SMC || smc.score >= MIN_SMC_SCORE)`.
5. Optional strict gate: `USE_SMC_CONFLUENCE=true` enforces weighted SMC confluence thresholds (standard/sniper).

## Risk math

- Margin = `CAPITAL_PER_TRADE_INR`. Notional USDT = `margin / INR_PER_USDT * LEVERAGE`. Quantity = floor-to-step(`notional / entry`).
- TP / SL levels use **`TP_PRICE_PCT`** and **`SL_PRICE_PCT`** as **underlying price moves** (defaults ~1.5% / 1%). Legacy margin-target fields **`TARGET_PNL_PCT`** / **`STOP_LOSS_PCT`** remain in config for compatibility but exits follow the price-pct fields.
- Net PnL USDT = `(exit-entry) * qty * dir - (entryNotional + exitNotional) * TAKER_FEE - entryNotional * FUNDING_FEE_EST`. INR via `INR_PER_USDT`.

## Modes

| Mode | `PLACE_ORDER` | `READ_ONLY` | Behavior |
| ---- | ------------- | ----------- | -------- |
| Signals-only (default) | `false` | `true` | Strategy evaluated; **no** paper fills and **no** CoinDCX orders. |
| Paper trading | `true` | `true` | Simulated fills via `PaperExecutionAdapter`; CSV trade log; **no** CoinDCX writes. |
| Live | `true` | `false` | Real CoinDCX orders when `EXECUTION_MODE=live` and API keys set. |

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

Live CoinDCX execution requires **`PLACE_ORDER=true`** AND `EXECUTION_MODE=live` AND `READ_ONLY=false` AND non-empty `COINDCX_API_KEY` + `COINDCX_API_SECRET`. Startup throws if `live` is requested without keys/read-write. With **`PLACE_ORDER=false`** (default), no broker calls occur regardless of mode.

PostgreSQL persistence is deferred — JSONL ledger + atomic JSON wallet for now.

## Market data architecture

The worker uses route-aware combined-stream WebSockets (`BinanceMultiplexWs`) that subscribe to:

- `<sym>@kline_<tf>` for every entry in `BINANCE_TIMEFRAMES` (first = execution / LTF close).
- `<sym>@bookTicker` (top of book, paper fills).
- `<sym>@aggTrade` (trade tape, last-trade fallback).
- `<sym>@depth<N>@<speed>` partial book (or `<sym>@depth@<speed>` diff stream when `BINANCE_DEPTH_LEVELS=0`).
- `<sym>@markPrice@1s` for USD-M when `BINANCE_USE_MARK_PRICE=true`.
- `<sym>@ticker` for spot.

Components:

- **`MultiTimeframeStore`** — per `(symbol, tf)` candle ring (cap `1000`, dedupe by `openTime`).
- **`LocalOrderBook`** — when `BINANCE_DEPTH_LEVELS=0`, REST snapshot (`/fapi/v1/depth` or `/api/v3/depth`) bootstraps; diffs are buffered until `lastUpdateId` aligns then streamed; gap detection emits `desync` and re-snapshots.
- **`AggTradeTape`** — 1000-entry ring buffer with `lastPrice`, `volumeOver(s)`, `vwapOver(s)`.
- **`fetchHistoricalKlines`** — paginated `1500`-bar pulls between `startMs` and `endMs`, deduped & capped via `maxBars`.
- **Server lifecycle** — server `ping` is echoed via `pong`; `serverShutdown` triggers an immediate reconnect; a 23h rotation timer pre-empts Binance's 24h cap; backoff cap 60s.

## Shutdown

`Lifecycle` (in `src/lifecycle.ts`) handles ordered teardown:

1. Stops are run in **reverse registration order**.
2. Each stop honors a per-entry timeout (default `SHUTDOWN_TIMEOUT_MS`).
3. A hard `SHUTDOWN_FORCE_EXIT_MS` watchdog exits the process if any stop hangs.
4. Signals wired by `attachProcessHandlers`: `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`, `unhandledRejection`, `beforeExit`.

`src/index.ts` registers `multiplex_ws` then `orchestrator` so shutdown closes the orchestrator (which flushes paper wallet/ledger and stops funding) before tearing down the WebSocket.

## Env reference

| Var | Default | Purpose |
| --- | ------- | ------- |
| `TRADING_ASSET` | `sol` | `sol` / `eth` / `btc` → preset Binance + CoinDCX pair; `custom` → use `BINANCE_SYMBOL` + `COINDCX_PAIR` |
| `PLACE_ORDER` | `false` | **`true`** required for any adapter order (paper simulation or live). Legacy: `EXECUTION_ENABLED` if `PLACE_ORDER` unset |
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
| `BINANCE_WS_BASE` | `wss://fstream.binance.com` | USD-M futures WS root; the app routes streams to `/market` or `/public` |
| `USDM_MARK_REST_POLL_SEC` | `5` | USD-M only: poll `premiumIndex` for mark/LTP; `0` = WebSocket only |
| `BINANCE_TIMEFRAMES` | `5m,15m,1h,4h,1d` | Comma-separated kline TFs; first = execution interval (candle close) |
| `BINANCE_HISTORY_BARS` | `500` | Bars seeded per timeframe at startup (50..2000) |
| `BINANCE_DEPTH_LEVELS` | `20` | `0` (diff stream + `LocalOrderBook`) or `5`/`10`/`20` (partial top) |
| `BINANCE_DEPTH_SPEED` | `100ms` | `100ms` or `500ms` |
| `BINANCE_USE_AGGTRADE` | `true` | Subscribe `@aggTrade` and feed `AggTradeTape` |
| `BINANCE_USE_BOOKTICKER` | `true` | Subscribe `@bookTicker` for paper fills |
| `BINANCE_USE_MARK_PRICE` | `true` | USD-M: subscribe `@markPrice@1s` |
| `BINANCE_WS_RECONNECT_HOURS` | `23` | Pre-empt Binance's 24h max-connection by rotating early |
| `SHUTDOWN_TIMEOUT_MS` | `5000` | Per-entry stop timeout |
| `SHUTDOWN_FORCE_EXIT_MS` | `10000` | Hard force-exit watchdog if shutdown hangs |

## Where logs go

- **Terminal:** every `log.info` / `log.warn` line is still printed to stdout/stderr.
- **NDJSON file:** default **`APP_LOG_PATH=./logs/app.ndjson`** (set empty to disable file logging). Each line is one JSON object: `ts`, `level`, `msg`, plus any metadata fields.
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
| `binance_ws_connected` | WS is up; streaming USD-M klines + mark on `/market` and book/depth on `/public` when enabled. |
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
