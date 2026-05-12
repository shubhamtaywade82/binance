# Binance FAPI live trading bot — TypeScript

Multi-timeframe Smart Money Concepts (SMC) strategy with full Binance USD-M Futures execution.

**Market data:** Binance public REST + multiplexed WebSocket (klines, mark price, aggTrade, bookTicker, depth, forceOrder).  
**Execution:** Binance FAPI signed REST (HMAC-SHA256) + private user-data WebSocket — or CoinDCX (legacy) — or paper simulation.

Official Binance reference: [USD-M Futures general info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info) · [WebSocket market streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams).  
In-repo API map: [docs/binance-usdm-perpetual-reference.md](docs/binance-usdm-perpetual-reference.md).

---

## Quick start

```bash
cp .env.example .env       # edit credentials + mode
npm install
npm run dev                # hot-reload on src/ changes (set DASHBOARD_ENABLED=true in `.env` for UI WebSocket)
npm run dev:once           # single run
npm run dashboard          # same as the bot with DASHBOARD_ENABLED=true (no separate process)
npm run check              # typecheck + lint
npm run readiness:binance  # live-readiness checklist for SOL 1.5%
```

---

## Execution modes

| Mode | `EXECUTION_MODE` | `PLACE_ORDER` | `READ_ONLY` | Adapter | Behavior |
|------|-----------------|---------------|-------------|---------|----------|
| **Paper** (default) | `paper` | `true` | `true` | `PaperExecutionAdapter` | Simulated fills against Binance bookTicker. No exchange orders. |
| **Signals-only** | `paper` | `false` | `true` | — | Strategy + logs; no positions. |
| **Binance live** | `live` | `true` | `false` | `BinanceLiveExecutionAdapter` | Real Binance FAPI orders (HMAC REST + private WS). Requires `BINANCE_API_KEY` + `BINANCE_API_SECRET` + `BINANCE_EXECUTION_ADAPTER=true`. |
| **CoinDCX live** (legacy) | `live` | `true` | `false` | `CoinDcxExecutionAdapter` | Real CoinDCX orders. Requires `COINDCX_API_KEY` + `COINDCX_API_SECRET`. |

### Binance live order flow

1. `POST /fapi/v1/leverage` — set leverage  
2. `POST /fapi/v1/marginType ISOLATED` — idempotent  
3. `POST /fapi/v1/order MARKET` — entry fill  
4. `POST /fapi/v1/algoOrder TAKE_PROFIT_MARKET` — TP1 (60% qty at +0.9%)  
5. `POST /fapi/v1/algoOrder TAKE_PROFIT_MARKET` — TP2 (closePosition at +1.5%)  
6. `POST /fapi/v1/algoOrder STOP_MARKET` — SL (closePosition)

> TP and SL use the **Algo Service** (`/fapi/v1/algoOrder`) per the Dec 2025 Binance migration. `workingType: MARK_PRICE`, `timeInForce: GTE_GTC`.

### Exchange-triggered reconciliation (ORDER_TRADE_UPDATE)

When a TP/SL algo order fills on the exchange, the **private user-data WebSocket** fires `ORDER_TRADE_UPDATE` with the algo `strategyId` (`si` field). The orchestrator calls `adapter.notifyFilled(strategyId, fillPrice)` which cancels sibling orders and returns the close event — no redundant MARKET order is sent.

### Startup reconciliation

On boot, the adapter calls `GET /fapi/v2/positionRisk` + `GET /fapi/v1/openAlgoOrders`. If an open position is found, state is restored and algo order IDs are re-attached so cancel-on-close still works after a crash/restart.

---

## Trading asset

Set `TRADING_ASSET=sol` | `eth` | `btc` — fills `BINANCE_SYMBOL` (USD-M) and `COINDCX_PAIR` from presets in [`src/config/asset-presets.ts`](src/config/asset-presets.ts). Use `TRADING_ASSET=custom` with explicit `BINANCE_SYMBOL` + `COINDCX_PAIR` for other markets.

Defaults: `BINANCE_TIMEFRAMES=5m,15m,1h,4h,1d`, `USE_SOL_MTF_STRATEGY=true`, `TP_PRICE_PCT=0.015`, `SL_PRICE_PCT=0.01`.

---

## Strategy

Per LTF candle close:

1. **HTF bias** from 1h EMA(9/21) stack.
2. **LTF `analyzeTrend`** — scores 6 indicators (EMA cross, MACD hist sign+slope, RSI > 45 / < 55, Supertrend, HH/HL or LH/LL swing structure, volume ≥ 0.8× 20-bar avg). Direction set when ≥ 4 align + volume confirms.
3. **SMC overlay** (`USE_SMC=true`) — liquidity sweep, order block, FVG, BOS/CHoCH. Score = concepts agreeing with HTF.
4. Enter only when `htf === ltf !== 'NONE'` AND `confidence >= MIN_CONFIDENCE` AND `smc.score >= MIN_SMC_SCORE`.
5. **SMC confluence** (`USE_SMC_CONFLUENCE`, default on) — weighted thresholds (standard ≥ 3 / sniper ≥ 4).

Full strategy spec: [`docs/sol-1p5-smc-strategy.md`](docs/sol-1p5-smc-strategy.md).

---

## Risk sizing

**USDT-native (preferred for Binance):** set `CAPITAL_PER_TRADE_USDT=200` → 200 USDT margin × `LEVERAGE` = notional. Quantity = `floor(notional / entry, stepSize)`.

**INR-based (fallback):** `CAPITAL_PER_TRADE_INR / INR_PER_USDT * LEVERAGE / entry`.

TP/SL levels use `TP_PRICE_PCT` and `SL_PRICE_PCT` as price moves (defaults 1.5% / 1%).

Net PnL USDT = `(exit − entry) × qty × dir − (entry + exit) × notional × TAKER_FEE − entry × notional × FUNDING_FEE_EST`.

---

## Paper engine

| Component | Purpose |
|-----------|---------|
| `PaperWallet` | Balance / margin / unrealized; atomic `wallet.json` |
| `SlippageEngine` | `0.5×spread + 0.15×volPct + 1e-5×qty + bps/1e4` |
| `FundingEngine` | Polls `GET /fapi/v1/premiumIndex` every `PAPER_FUNDING_POLL_SEC`; charges open positions at funding time |
| `LiquidationEngine` | `entry × (1 ∓ 1/lev ± maint)`; auto-closes via `onMark` |
| `Ledger` | Append-only JSONL trades + equity snapshots |

Output layout (`PAPER_LEDGER_DIR`, default `./paper`):
```
paper/
├── wallet.json     # current state (atomic write)
├── trades.jsonl    # one ClosedPosition per line
└── equity.jsonl    # periodic equity snapshots
```

---

## Market data

`BinanceMultiplexWs` subscribes to (route-aware `/market` vs `/public`):

- `<sym>@kline_<tf>` for each timeframe in `BINANCE_TIMEFRAMES`
- `<sym>@bookTicker` (paper fills)
- `<sym>@aggTrade` (trade tape)
- `<sym>@depth<N>@<speed>` partial book, or `<sym>@depth@<speed>` diff stream when `BINANCE_DEPTH_LEVELS=0`
- `<sym>@markPrice@1s` (USD-M, when `BINANCE_USE_MARK_PRICE=true`)
- `<sym>@forceOrder` (liquidation feed, when `BINANCE_USE_FORCE_ORDER=true`)

REST fallback: `GET /fapi/v1/premiumIndex` polled every `USDM_MARK_REST_POLL_SEC` when `fstream` is silent.

---

## Shutdown

`Lifecycle` (`src/lifecycle.ts`) tears down in reverse registration order; each entry has `SHUTDOWN_TIMEOUT_MS` (default 5s) and a hard `SHUTDOWN_FORCE_EXIT_MS` (default 10s) watchdog. Signals: `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException`, `unhandledRejection`.

---

## Log events

| Event | Meaning |
|-------|---------|
| `binance_ws_connected` | WebSocket open |
| `ltp_connected` | First live price (`mark` / `mark_rest` / `ticker`) |
| `ltp_connect_timeout` | No price within `LTP_CONNECT_WARN_SEC` after open |
| `heartbeat` | Every `LOG_HEARTBEAT_SEC` — mark, HTF/LTF bias, bars, position status |
| `sol_mtf_strategy` | MTF pass/fail + direction per closed LTF bar |
| `smc_confluence` | Confluence score + threshold |
| `live_open` / `paper_open` | Position opened |
| `position_closed` | Position closed (`reason`, `netUsdt`, `netInr`, optional `source: exchange`) |
| `position_restored` | Position re-attached after restart |
| `startup_no_open_position` | No exchange position found at boot (Binance adapter only) |
| `binance_order_update` | Raw ORDER_TRADE_UPDATE from private WS |
| `binance_tp1_filled` | Partial TP1 fill; position still open |
| `binance_exchange_close` | Exchange-triggered TP2/SL — position fully closed |
| `binance_private_ws_connected` | Private user-data stream open |
| `binance_ws_reconnect` / `binance_ws_error` | Feed issues |

Logs go to `APP_LOG_PATH` (NDJSON, default `./logs/app.ndjson`) and stdout/stderr. Trades also appended to `TRADE_LOG_PATH` as CSV.

---

## Env reference

### Core

| Var | Default | Purpose |
|-----|---------|---------|
| `TRADING_ASSET` | `sol` | `sol` / `eth` / `btc` preset; `custom` = manual symbols |
| `BINANCE_SYMBOL` | `SOLUSDT` | USD-M futures symbol |
| `PLACE_ORDER` | `true` | `false` = signals-only |
| `EXECUTION_MODE` | `paper` | `paper` or `live` |
| `READ_ONLY` | `true` | Must be `false` for live execution |

### Binance live execution

| Var | Default | Purpose |
|-----|---------|---------|
| `BINANCE_EXECUTION_ADAPTER` | `false` | `true` = route live orders to Binance FAPI (not CoinDCX) |
| `BINANCE_API_KEY` | — | HMAC API key (enable Futures trading, restrict by IP) |
| `BINANCE_API_SECRET` | — | HMAC API secret |
| `BINANCE_PRIVATE_WS_ENABLED` | `false` | Enable private user-data WebSocket (auto-enabled when adapter=true + live) |
| `BINANCE_FUTURES_TESTNET` | `false` | `true` → REST `testnet.binancefuture.com`, WS `fstream.binancefuture.com` |

### Risk sizing

| Var | Default | Purpose |
|-----|---------|---------|
| `CAPITAL_PER_TRADE_USDT` | `0` | **USDT margin per trade** (preferred). `0` = fall back to INR path |
| `CAPITAL_PER_TRADE_INR` | `20000` | INR margin (used when USDT cap is 0) |
| `INR_PER_USDT` | `85` | FX rate for INR sizing |
| `LEVERAGE` | `10` | Position leverage |
| `TP_PRICE_PCT` | `0.015` | Take-profit price move (1.5%) |
| `SL_PRICE_PCT` | `0.01` | Stop-loss price move (1%) |
| `MIN_CONFIDENCE` | `0.65` | Min trend indicator confidence |
| `MIN_SMC_SCORE` | `2` | Min SMC concepts confirming |

### Fees

| Var | Default | Purpose |
|-----|---------|---------|
| `TAKER_FEE` | `0.0005` | Taker fee fraction |
| `MAKER_FEE` | `0.0002` | Maker fee fraction |
| `FUNDING_FEE_EST` | `0.0001` | Estimated funding per trade |

### Market data

| Var | Default | Purpose |
|-----|---------|---------|
| `BINANCE_PRODUCT` | `usdm` | `usdm` or `spot` |
| `BINANCE_TIMEFRAMES` | `5m,15m,1h,4h,1d` | Kline intervals; first = execution/LTF |
| `BINANCE_HISTORY_BARS` | `500` | Bars seeded per TF at startup (50–2000) |
| `BINANCE_DEPTH_LEVELS` | `20` | `0` = diff stream; `5`/`10`/`20` = partial top |
| `BINANCE_DEPTH_SPEED` | `100ms` | `100ms` or `500ms` |
| `BINANCE_USE_AGGTRADE` | `true` | `@aggTrade` trade tape |
| `BINANCE_USE_BOOKTICKER` | `true` | `@bookTicker` for paper fills |
| `BINANCE_USE_MARK_PRICE` | `true` | USD-M `@markPrice@1s` |
| `BINANCE_USE_FORCE_ORDER` | `false` | `@forceOrder` liquidation feed |
| `BINANCE_WS_RECONNECT_HOURS` | `23` | Pre-empt Binance 24h max-connection |
| `USDM_MARK_REST_POLL_SEC` | `5` | REST fallback poll for mark price; `0` = WS only |

### Paper engine

| Var | Default | Purpose |
|-----|---------|---------|
| `PAPER_INITIAL_BALANCE_USDT` | `10000` | Starting wallet balance |
| `PAPER_MAINT_MARGIN` | `0.005` | Maintenance margin ratio for liquidation |
| `PAPER_BASE_SLIPPAGE_BPS` | `2` | Base slippage in bps |
| `PAPER_LATENCY_MS` | `150` | Simulated fill latency |
| `PAPER_LEDGER_DIR` | `./paper` | Directory for wallet.json + JSONL ledger |
| `PAPER_FUNDING_POLL_SEC` | `300` | Funding poll interval |
| `PAPER_EQUITY_SNAPSHOT_SEC` | `5` | Equity snapshot interval |

### Logging / misc

| Var | Default | Purpose |
|-----|---------|---------|
| `APP_LOG_PATH` | `./logs/app.ndjson` | NDJSON log file (empty = stdout only) |
| `TRADE_LOG_PATH` | `./logs/trades.csv` | Per-trade audit CSV |
| `LOG_HEARTBEAT_SEC` | `60` | Heartbeat interval; `0` = disable |
| `LTP_CONNECT_WARN_SEC` | `15` | Warn if no LTP after WS open; `0` = disable |
| `SHUTDOWN_TIMEOUT_MS` | `5000` | Per-entry stop timeout |
| `SHUTDOWN_FORCE_EXIT_MS` | `10000` | Hard force-exit watchdog |

---

## Safety checklist before going live

1. Set `EXECUTION_MODE=live`, `READ_ONLY=false`, `PLACE_ORDER=true`
2. Set `BINANCE_EXECUTION_ADAPTER=true` with `BINANCE_API_KEY` + `BINANCE_API_SECRET`
3. Enable Futures trading on your API key; restrict by IP
4. Set `CAPITAL_PER_TRADE_USDT` (e.g. `200`) — preferred over INR-based sizing
5. Confirm `BINANCE_FUTURES_TESTNET=false` for mainnet
6. Run `npm run readiness:binance` — fix any flagged items
7. Paper trade first (`EXECUTION_MODE=paper`) to verify signal flow
8. Check `startup_no_open_position` or `position_restored` in logs at boot
