# TODO — Binance USDⓈ-M Futures Production Trading System

Gaps between the current codebase and the full production-grade spec.
Items marked ✅ are already implemented.

> **Scope note (2026-05-13):** This file mixes **shipped features** with a **multi-month roadmap** (ML stack, Postgres, multi-symbol live execution, full REST surface, etc.). Only rows that exist in the TypeScript bot today should be marked ✅; everything else remains backlog unless explicitly built.

---

## 1. REST API — Order Management

| Status | Endpoint | Notes |
|--------|----------|-------|
| ✅ | `POST /fapi/v1/order` | Market entry implemented |
| ✅ | `DELETE /fapi/v1/order` | Cancel single order |
| ✅ | `DELETE /fapi/v1/allOpenOrders` | Cancel all open orders |
| ✅ | `POST /fapi/v1/algoOrder` | TP/SL via Algo Service |
| ✅ | `DELETE /fapi/v1/algoOrder` | Cancel single algo order |
| ✅ | `DELETE /fapi/v1/algoOrderList` | Cancel all algo orders for symbol |
| ✅ | `GET /fapi/v1/openAlgoOrders` | Fetch open TP/SL IDs |
| ✅ | `PUT /fapi/v1/order` | **Modify Order** — `modifyOrder` in `rest-trade.ts`; amend price/qty in-place |
| ✅ | `POST /fapi/v1/batchOrders` | **Place Multiple Orders** — `placeBatchOrders` + `placeEntryWithBracket` on adapter |
| ✅ | `PUT /fapi/v1/batchOrders` | **Modify Multiple Orders** — `modifyBatchOrders` in `rest-trade.ts` |
| ✅ | `DELETE /fapi/v1/batchOrders` | **Cancel Multiple Orders** — `cancelBatchOrders` in `rest-trade.ts` |
| ✅ | `POST /fapi/v1/countdownCancelAll` | **Auto-Cancel All** — `setCountdownCancelAll`; orchestrator renews when `BINANCE_DEADMAN_COUNTDOWN_MS>0` |
| ✅ | `GET /fapi/v1/order` | **Query Order** — `getOrder` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/openOrders` | **All Open Orders** — `getOpenOrders`; used at startup reconcile |
| ✅ | `GET /fapi/v1/allOrders` | **Full Order History** — `getAllOrders` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/userTrades` | **Trade List** — `getUserTrades`; startup reconcile logs recent fills |
| ✅ | `GET /fapi/v1/algoOrder` | **Query Algo Order** — `getAlgoOrder` by symbol + algoId in `rest-trade.ts` |
| ✅ | `POST /fapi/v1/order/test` | **Test New Order** — `testNewOrder` in `rest-trade.ts`; validate filters without execution |

---

## 2. REST API — Account / Risk / Config

| Status | Endpoint | Notes |
|--------|----------|-------|
| ✅ | `GET /fapi/v2/account` | Account info |
| ✅ | `GET /fapi/v2/balance` | Asset balances |
| ✅ | `GET /fapi/v2/positionRisk` | Per-symbol position state |
| ✅ | `GET /fapi/v1/commissionRate` | **User Commission Rate** — `getCommissionRate` in `rest-trade.ts`; returns real maker/taker rates |
| ✅ | `GET /fapi/v1/accountConfig` | **Account Configuration** — `getAccountConfig` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/symbolConfig` | **Symbol Configuration** — `getSymbolConfig` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/leverageBracket` | **Notional & Leverage Brackets** — `getLeverageBracket` + `bracketForNotional` + `validateNotionalAgainstBracket` |
| ✅ | `GET /fapi/v1/multiAssetsMargin` | **Multi-Assets Mode** — `getMultiAssetsMargin` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/positionSide/dual` | **Position Mode** — `getPositionSideDual`; hedge → `positionSide` on live orders |
| ✅ | `GET /fapi/v1/rateLimit/order` | **Order Rate Limit** — polled; pauses new entries when `ORDER_RATE_LIMIT_PAUSE_THRESHOLD` exceeded |
| ✅ | `GET /fapi/v1/income` | **Income History** — `getIncomeHistory` in `rest-trade.ts`; realized PnL, fees, funding flows |

---

## 3. REST API — Market Data

| Status | Endpoint | Notes |
|--------|----------|-------|
| ✅ | `GET /fapi/v1/exchangeInfo` | Tick/step precision |
| ✅ | `GET /fapi/v1/depth` | Orderbook snapshot |
| ✅ | `GET /fapi/v1/klines` | Historical candles |
| ✅ | `GET /fapi/v1/premiumIndex` | Mark price + funding rate |
| ✅ | `GET /fapi/v1/ticker/bookTicker` | **REST Best Bid/Ask** — `getBookTicker` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/ticker/24hr` | **24h Ticker Stats** — `getTicker24hr` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/fundingRate` | **Funding Rate History** — `getFundingRateHistory` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/trades` | **Recent Trades** — `getRecentTrades` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/historicalTrades` | **Historical Trades** — `getHistoricalTrades` in `rest-trade.ts` |
| ✅ | `GET /fapi/v1/openInterest` | **Current Open Interest** — `getOpenInterest` in `rest-trade.ts` |
| ✅ | `GET /futures/data/openInterestHist` | **OI Statistics History** — `getOpenInterestHist` in `rest-trade.ts` |

---

## 4. WebSocket Market Streams

| Status | Stream | Notes |
|--------|--------|-------|
| ✅ | `<symbol>@aggTrade` | Trade tape |
| ✅ | `<symbol>@markPrice@1s` | Mark price |
| ✅ | `<symbol>@kline_<interval>` | Live candles |
| ✅ | `<symbol>@depth@100ms` | Incremental orderbook |
| ✅ | `<symbol>@bookTicker` | Best bid/ask |
| ✅ | `<symbol>@ticker` | 24h ticker / LTP |
| ✅ | `<symbol>@forceOrder` | Per-symbol liquidations |
| ✅ | `<symbol>@miniTicker` | **Mini Ticker** — `useMiniTicker` option + `onMiniTicker` callback in multiplex |
| ✅ | `!ticker@arr` | **All-symbol Ticker Array** — `useGlobalTicker` option; dispatches to `on24hrTicker` per item |
| ✅ | `!miniTicker@arr` | **All-symbol Mini Ticker Array** — `useGlobalMiniTicker` option; dispatches to `onMiniTicker` per item |
| ✅ | `!bookTicker` | **All-symbol Best Bid/Ask** — `useGlobalBookTicker` option in multiplex |
| ✅ | `!forceOrder@arr` | **All-symbol Liquidation Stream** — `useGlobalForceOrder` option in multiplex; config `BINANCE_USE_GLOBAL_FORCE_ORDER` |
| ✅ | `!contractInfo` | **Contract Info Stream** — `useContractInfo` option + `onContractInfo` callback in multiplex |

---

## 5. Private User-Data Stream Events

| Status | Event | Notes |
|--------|-------|-------|
| ✅ | `ORDER_TRADE_UPDATE` | Fill + order lifecycle |
| ✅ | `ACCOUNT_UPDATE` | Balance + position changes |
| ✅ | `MARGIN_CALL` | Margin warning |
| ✅ | `TRADE_LITE` | **Trade Lite** — `onTradeLite` handler in `private-ws.ts` |
| ✅ | `ACCOUNT_CONFIG_UPDATE` | **Account Config Update** — `onAccountConfigUpdate` handler in `private-ws.ts` |
| ✅ | `ALGO_ORDER_UPDATE` | **Algo stream** — private WS dispatches `ALGO_UPDATE` / `ALGO_ORDER_UPDATE` to structured log |
| ✅ | `CONDITIONAL_ORDER_TRIGGER_REJECT` | **Conditional Reject** — private WS logs `CONDITIONAL_ORDER_TRIGGER_REJECT` |
| ✅ | `STRATEGY_UPDATE` | **Strategy Update** — `onStrategyUpdate` handler in `private-ws.ts` |
| ✅ | `GRID_UPDATE` | **Grid Update** — `onGridUpdate` handler in `private-ws.ts` |
| ✅ | Listen-key expiry handling | **On `listenKeyExpired`** — mint new key, delete old (best-effort), reconnect WS |

---

## 6. WebSocket API (Trading over WS)

| Status | Method | Notes |
|--------|--------|-------|
| ✅ | `session.logon` | Ed25519 auth implemented |
| ✅ | `order.place` | WS order placement |
| ✅ | `order.cancel` | WS order cancel |
| ✅ | `algoOrder.place` | WS algo order |
| ✅ | `algoOrder.cancel` | WS algo cancel |
| ✅ | `session.status` | **Session Status** — `sessionStatus()` on `BinanceFuturesWsApiClient` |
| ✅ | `session.logout` | **Session Logout** — `logout()` on `BinanceFuturesWsApiClient` |
| ✅ | `order.modify` | **Modify Order** — `orderModify` on `BinanceFuturesWsApiClient` |
| ✅ | `order.status` | **Query Order** — `orderStatus()` on `BinanceFuturesWsApiClient` |

---

## 7. Risk Engine

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Position sizing (USDT-native) | Capital × leverage / entry |
| ✅ | TP/SL percentage targets | Configurable via env |
| ✅ | Paper liquidation engine | Maintenance margin model |
| ✅ | **Drawdown kill switch** | `DAILY_DRAWDOWN_KILL_PCT` — vs session peak USDT `wb`; halts new entries + cancels open orders on breach |
| ✅ | **Max open positions limit** | `MAX_OPEN_POSITIONS` config; checked in `evaluate()` before entry |
| ✅ | **Volatility-adjusted sizing** | `VOL_ADJUSTED_SIZING` + `VOL_BASELINE` config; RiskManager scales margin down when rv > baseline (capped [0.5, 1.0]) |
| ✅ | **Spread guard** | `MAX_ENTRY_SPREAD_BPS` config + `spreadBps()` check in `evaluate()` |
| ✅ | **Rate-limit circuit breaker** | Entry pause when ORDER row `count/limit` ≥ `ORDER_RATE_LIMIT_PAUSE_THRESHOLD` |
| ✅ | **Leverage bracket validation** | `validateNotionalAgainstBracket` checks notional + leverage vs tier caps |
| ✅ | **Time-based session filter** | `TRADING_HOURS_UTC` config (e.g. `02:00-21:00`); `isWithinTradingHours()` guard in `evaluate()` |
| ✅ | **Cross-symbol correlation guard** | `src/risk/correlation-guard.ts` — `CorrelationGuard` blocks same-direction on correlated pairs + opposite-direction on negatively correlated |
| ✅ | **countdownCancelAll integration** | `BINANCE_DEADMAN_COUNTDOWN_MS` + periodic `setCountdownCancelAll` |

---

## 8. Execution Engine

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Market order entry | Long/Short |
| ✅ | Algo TP1 / TP2 / SL | Via Algo Service |
| ✅ | Precision rounding | tick/step size |
| ✅ | Reduce-only close orders | Via closePosition flag |
| ✅ | **Batch order submission** | `placeBatchOrders` + `placeEntryWithBracket` (MARKET + STOP SL + TP in one request; fallback to sequential) |
| ✅ | **Modify order in-place** | `modifyOrder` REST + `orderModify` WS + `modifyRegularOrder` / `amendAlgoStopPrice` on adapter |
| ✅ | **Post-only limit entry** | `ENTRY_ORDER_TYPE=LIMIT_GTX` config; adapter sends `LIMIT` + `GTX` at microprice for maker fills |
| ✅ | **Trailing stop** | `TRAILING_STOP_CALLBACK_RATE` config; adapter places `TRAILING_STOP_MARKET` algo SL when > 0 |
| ✅ | **Hedge mode support** | `GET /fapi/v1/positionSide/dual` → `BinanceLiveExecutionAdapter.setHedgeMode` → `positionSide` on entry/algo/close |
| ✅ | **clientOrderId deduplication** | `generateClientOrderId(symbol, side, ts)` — deterministic SHA256 prefix for idempotent retry |
| ✅ | **Exponential backoff retry** | `src/execution/retry-with-backoff.ts` — `retryWithBackoff()` with exponential delay, jitter, status code detection, `RetryError` |
| ✅ | **Post-execution slippage log** | `slippage_log` emitted on every fill: `refPrice`, `fillPrice`, `slippageBps`, `latencyMs` |

---

## 9. Market Microstructure Features

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Order Book Imbalance (OBI) | Top-N bid/ask volume ratio |
| ✅ | AggTrade tape | Ring buffer of recent trades |
| ✅ | **Trade Flow Imbalance (TFI)** | `tradeFlowImbalance(tape, windowSec)` in `microstructure.ts`; 1 s / 5 s / 30 s windows; wired into orchestrator heartbeat + dashboard |
| ✅ | **Weighted OBI** | `weightedObi(book, levels)` in `microstructure.ts`; level-distance weighting; top-5 / top-10 snapshots in dashboard |
| ✅ | **Microprice** | `microprice(book)` in `microstructure.ts`; `(ask × bidVol + bid × askVol) / (bidVol + askVol)`; included in heartbeat + UI |
| ✅ | **Order Flow Imbalance (OFI)** | `createOfiTracker` + `updateOfi` in `microstructure.ts`; Δbid_size − Δask_size per depth diff |
| ✅ | **Depth pressure** | `depthPressure(book, levels)` in `microstructure.ts`; Σ(vol / dist) per side |
| ✅ | **Rolling realized volatility** | `rollingRealizedVol(tape, windowSec)` in `microstructure.ts`; 1 s / 5 s / 1 m windows in snapshot |
| ✅ | **Liquidation cascade signal** | `LiquidationCascadeTracker` in `src/signals/liquidation-tracker.ts`; rolling volume/count/side-bias; wired via `onForceOrder` |
| ✅ | **Open Interest delta** | `OiPoller` in `src/signals/oi-poller.ts`; polls `getOpenInterest`, tracks OI delta + z-score + `priceOiRegime` |
| ✅ | **Funding rate pressure** | `FundingTracker` in `src/signals/funding-tracker.ts`; rolling mean/std/z-score from `@markPrice` funding rate |

---

## 10. Multi-Timeframe Feature Pipeline

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Candle aggregation (1m → higher TF) | MultiTfStore |
| ✅ | 5-TF SMC confluence scoring | daily/h4/h1/m15/m5 |
| ✅ | **1 s / 5 s micro aggregates** | `src/features/micro-aggregator.ts` — `MicroAggregator` with time-based eviction (mean/max/min/count) |
| ✅ | **Rolling feature vectors** | `src/features/rolling-feature-ring.ts` — `Float64Array`-backed ring buffer with mean/std/min/max |
| ✅ | **Feature normalization layer** | z-score in `feature-normalizer.ts` + min-max in `src/features/min-max-normalizer.ts` |
| ✅ | **Multi-symbol feature bus** | `src/features/feature-bus.ts` — `FeatureBus` manages per-symbol snapshots for cross-asset signals |

---

## 11. Persistence & State

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Paper wallet JSON (atomic write) | Balance + margin snapshot |
| ✅ | Paper ledger JSONL | ClosedPosition append log |
| ✅ | NDJSON app logger | Structured log stream |
| DEFERRED | **PostgreSQL / ClickHouse** | Durable storage for orders, trades, positions, features |
| DEFERRED | **Redis hot state** | Sub-ms read for active position, OBI, last price across processes |
| DEFERRED | **Order replay on restart** | Re-fetch open orders via `GET /fapi/v1/openOrders` + algo orders; rebuild in-memory state fully |
| ✅ | **Income reconciliation** | `IncomeReconciler` in `src/signals/income-reconciler.ts`; periodic `getIncomeHistory` + local PnL comparison + discrepancy callback |
| ✅ | **Trade attribution** | `TradeAttribution` interface on `ClosedPosition`; CSV log extended with `entrySignal,smcZone,htfBias,confidence` columns |

---

## 12. Observability & Monitoring

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | NDJSON + stdout logger | Heartbeat every 60 s |
| ✅ | Real-time dashboard (WS bridge) | Browser UI for market data + signals |
| DEFERRED | **Prometheus metrics export** | Orders placed/filled, latency histograms, PnL gauge, WS reconnects |
| DEFERRED | **Grafana dashboard** | Visualize metrics from Prometheus |
| DEFERRED | **Alert webhooks** | Slack/email/Telegram on: margin call, kill-switch trigger, WS down > N s |
| ✅ | **Order latency tracking** | `src/observability/latency-tracker.ts` — `LatencyTracker` with send/ack/fill timestamps + p50/p95/p99 stats |
| ✅ | **Fill quality report** | `src/observability/fill-quality.ts` — `FillQualityTracker` with signed slippage bps + mean/median/std report |
| DEFERRED | **Equity curve snapshot** | Periodic equity + drawdown time-series to DB |
| DEFERRED | **External watchdog** | Separate process that pings bot heartbeat; force-closes all positions if silent > N s |

---

## 13. Backtesting & Research

| Status | Feature | Notes |
|--------|---------|-------|
| DEFERRED | **Backtest engine** | Replay historical klines + orderbook snapshots through strategy + execution pipeline |
| DEFERRED | **WS stream recorder** | Record raw WS frames to disk for replay |
| DEFERRED | **Walk-forward validation** | Out-of-sample parameter validation (prevent curve-fitting) |
| DEFERRED | **Parameter sweep** | Grid or Bayesian search over `MIN_CONFIDENCE`, `MIN_SMC_SCORE`, `TP_PRICE_PCT`, etc. |
| DEFERRED | **PnL attribution reports** | Win rate, avg hold time, profit factor by signal / TF / session |
| DEFERRED | **Execution quality simulator** | Model fill price, slippage, and queue position in backtest |

---

## 14. Infrastructure & Scalability

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Single-symbol live trading | SOL/ETH/BTC |
| ✅ | Watchlist multi-symbol market data | Feed ingestion only |
| DEFERRED | **Multi-symbol live execution** | Concurrent position management across watchlist symbols |
| DEFERRED | **Config hot-reload** | Reload env/config without full process restart |
| DEFERRED | **Multi-account support** | Run separate strategy instances per API key |
| DEFERRED | **NATS / ZeroMQ message bus** | Decouple ingestion, strategy, and execution into separate processes |
| DEFERRED | **WS payload compression** | Enable `permessage-deflate` on WS connections |
| DEFERRED | **VPS co-location** | Deploy to AWS `ap-southeast-1` (Singapore) for minimal Binance round-trip latency |
| DEFERRED | **CPU affinity pinning** | Pin execution loop to isolated core (Linux `taskset`) |

---

## 15. Recommended Build Order (Priority)

### P0 — Correctness / Safety (do first)

> **2026-05-13 snapshot:** The TypeScript bot now covers most of the REST/WS/risk items below (startup reconcile with `openOrders` + `userTrades` + dual mode + rate snapshot; hedge `positionSide`; dead-man countdown; drawdown + order-rate entry pauses; private WS algo + conditional reject + listen-key rotation). Remaining gaps are called out inline.

1. `GET /fapi/v1/openOrders` + `GET /fapi/v1/userTrades` — complete state reconciliation on restart
2. `GET /fapi/v1/positionSide/dual` — prevent wrong-side order rejections in hedge mode accounts
3. `GET /fapi/v1/rateLimit/order` + rate-limit circuit breaker
4. `POST /fapi/v1/countdownCancelAll` — dead-man switch for unattended operation
5. Drawdown kill switch (daily loss cap → close-all + disable entries)
6. Listen-key expiry event handling
7. `ALGO_ORDER_UPDATE` + `CONDITIONAL_ORDER_TRIGGER_REJECT` private stream events

### P1 — Edge & Execution Quality
8. ✅ Trade Flow Imbalance (TFI) — `microstructure.ts` + tests + orchestrator + dashboard
9. ✅ Weighted OBI + Microprice — `microstructure.ts` + tests + orchestrator + dashboard
10. ✅ `PUT /fapi/v1/order` / `order.modify` — REST + WS + adapter `modifyRegularOrder` + `amendAlgoStopPrice`
11. ✅ `POST /fapi/v1/batchOrders` — `placeBatchOrders` + `modifyBatchOrders` + `cancelBatchOrders` + adapter `placeEntryWithBracket`
12. ✅ `GET /fapi/v1/leverageBracket` — `getLeverageBracket` + `bracketForNotional` + `validateNotionalAgainstBracket`
13. ✅ `GET /fapi/v1/income` — `getIncomeHistory` with type/time/symbol filters
14. ✅ `GET /fapi/v1/commissionRate` — `getCommissionRate` for real maker/taker rates

### P2 — Analytics & Research
15. ✅ `GET /fapi/v1/openInterest` — `getOpenInterest` + polling-ready interface
16. ✅ `GET /futures/data/openInterestHist` — `getOpenInterestHist` with period/time filters
17. ✅ `GET /fapi/v1/fundingRate` — `getFundingRateHistory` with symbol/time filters
18. ✅ `!forceOrder@arr` — `useGlobalForceOrder` in multiplex + `BINANCE_USE_GLOBAL_FORCE_ORDER` config
19. DEFERRED — PostgreSQL persistence layer
20. DEFERRED — Backtest engine (kline replay)

### P3 — Production Hardening (all DEFERRED — requires external infra)
21. DEFERRED — Prometheus metrics + Grafana
22. DEFERRED — Alert webhooks (Slack/Telegram)
23. DEFERRED — External watchdog process
24. DEFERRED — Redis hot state cache
25. DEFERRED — Multi-symbol live execution
26. DEFERRED — Walk-forward parameter validation

---

## 16. AI / ML Trading System

> **Current state — COMPLETE (infra + Phase 1)**:
> All sections 16.1–16.9 implemented. Feature pipeline (55 columns), label builder (direction/regression/vol/regime
> with leakage guard, cost-adjusted, multi-horizon), data pipeline (stream alignment, stale guard, OI poll),
> Phase 1 models (LightGBM direction + vol regressor, SHAP, walk-forward), live inference (ONNX export,
> model versioning, model registry), decision logic (vol sizing, hold-time optimizer, execution gate),
> training pipeline (drift detection, scheduled retraining), post-trade analytics (calibration, feature drift,
> signal decay, PnL attribution). Phase 2/3 (sequence models, multimodal ensemble) deferred to future work.
> **Next**: Collect training data → train baseline → deploy inference server → validate in shadow mode.

---

### 16.1 What to Predict (Model Targets)

| Status | Target | Notes |
|--------|--------|-------|
| ✅ | `P(return > +N bps in next T seconds)` | `y_direction_{h}s` labels → LightGBM classifier → `p_up` |
| ✅ | `P(return < −N bps in next T seconds)` | Same classifier → `p_down` |
| ✅ | `expected_return` over next N seconds | `y_reg_{h}s` clipped regression labels in `label_builder.py` |
| ✅ | `expected_volatility` over next N seconds | `y_vol_{h}s` → LightGBM regressor → `expected_volatility` served via `/infer` |
| ✅ | `regime` ∈ {trend, mean-revert, chop, high-vol, low-liq} | `label_regime` + `_classify_regime()` → `regime` in `/infer` response |
| ✅ | `fill_probability` | `y_fill_prob_{h}s` labels → `train_fill_probability()` → `fill_probability` in `/infer` |
| ✅ | `slippage_bps` | `y_slippage_bps_{h}s` labels → `train_slippage()` → `expected_slippage` in `/infer` |
| ✅ | `adverse_move_probability` | `y_adverse_move_{h}s` labels → `train_adverse_move()` → `adverse_move_probability` in `/infer` |

---

### 16.2 Feature Schema

Every row in the training set and live inference vector should contain:

#### Microstructure features (strongest short-term signal)

| Status | Feature | Source |
|--------|---------|--------|
| ✅ | `spread` | Best ask − best bid — `feature-schema.ts` |
| ✅ | `microprice` | `(ask_px × bid_vol + bid_px × ask_vol) / (bid_vol + ask_vol)` — `feature-schema.ts` |
| ✅ | `obi_5` | Top-5 weighted bid/ask volume imbalance — `feature-schema.ts` |
| ✅ | `obi_10` | Top-10 weighted bid/ask volume imbalance — `feature-schema.ts` |
| ✅ | `weighted_depth_imbalance` | Level-distance weighted OBI — `feature-schema.ts` |
| ✅ | `order_flow_imbalance` | Δbid_size − Δask_size per depth diff — `feature-schema.ts` (ofi_cumulative) |
| ✅ | `book_slope_bid` / `book_slope_ask` | Volume-weighted price gradient — `microstructure.ts bookSlope()` + `feature-schema.ts` |
| ✅ | `liquidity_gap` | Largest price gap in top-20 levels — `microstructure.ts liquidityGap()` + `feature-schema.ts` |
| ✅ | `cancel_intensity` | Rate of depth level removals — `depth-change-tracker.ts` + `feature-schema.ts` |
| ✅ | `book_thinning` | Rolling decrease in total top-N depth volume — `depth-change-tracker.ts` + `feature-schema.ts` |
| ✅ | `bid_wall_persistence` / `ask_wall_persistence` | How long large levels survive before cancellation — `depth-change-tracker.ts` + `feature-schema.ts` |

#### Trade flow / aggression features

| Status | Feature | Source |
|--------|---------|--------|
| ✅ | `trade_imbalance_1s` / `5s` / `30s` | Buy vol − Sell vol — `feature-schema.ts` |
| ✅ | `trade_intensity_1s` | Trade count per second — `feature-schema.ts` |
| ✅ | `signed_volume_5s` | Net aggressor volume — `microstructure.ts tradeFlowExtended()` + `feature-schema.ts` |
| ✅ | `burstiness` | CV of inter-trade arrival times — `microstructure.ts tradeFlowExtended()` + `feature-schema.ts` |
| ✅ | `last_trade_direction_streak` | Consecutive same-side trades — `microstructure.ts tradeFlowExtended()` + `feature-schema.ts` |
| ✅ | `large_trade_flag` | Trade qty > 3× rolling avg qty — `microstructure.ts tradeFlowExtended()` + `feature-schema.ts` |

#### OHLCV / candle features

| Status | Feature | Source |
|--------|---------|--------|
| ✅ | `ret_1m` / `ret_5m` | Log returns at each TF — `feature-schema.ts` |
| ✅ | `vol_1m` | Realized volatility — `feature-schema.ts` (rv_1s, rv_5s, rv_1m) |
| ✅ | `candle_body_pct` | `abs(close − open) / (high − low)` — `feature-schema.ts` |
| ✅ | `wick_ratio_upper` | Wick size relative to range — `feature-schema.ts` |
| ✅ | `volume_zscore_1m` | Volume vs rolling mean/std — `microstructure.ts candleDerivedFeatures()` + `feature-schema.ts` |
| ✅ | `range_expansion` | Current range vs N-bar avg range — `microstructure.ts candleDerivedFeatures()` + `feature-schema.ts` |
| ✅ | `trend_slope` | Linear regression slope over last N bars — `microstructure.ts candleDerivedFeatures()` + `feature-schema.ts` |
| ✅ | `momentum_5m` / `momentum_15m` | Close-to-close return over N bars — `microstructure.ts candleDerivedFeatures()` + `feature-schema.ts` |

#### Open interest / derivatives features

| Status | Feature | Source |
|--------|---------|--------|
| ✅ | `oi_delta_1m` | Change in OI — `feature-schema.ts` |
| ✅ | `oi_delta_5m` | Change in OI over 5 min — extended `OiPoller.snapshot()` + `feature-schema.ts` |
| ✅ | `oi_zscore` | OI delta z-score — `feature-schema.ts` |
| ✅ | `price_oi_regime` | Encoded 0–4 — `feature-schema.ts` |
| ✅ | `oi_divergence` | OI direction opposing price direction — extended `OiPoller.snapshot()` + `feature-schema.ts` |
| ✅ | `oi_spike` | OI change > 2σ rolling std — extended `OiPoller.snapshot()` + `feature-schema.ts` |

#### Funding / mark price features

| Status | Feature | Source |
|--------|---------|--------|
| ✅ | `funding_zscore` | Current funding rate vs rolling 24h mean/std — `feature-schema.ts` |
| ✅ | `mark_last_basis` | `(mark_price − last_trade_price) / last_trade_price` — computed in `buildFeatureVector()` |
| ✅ | `liquidation_pressure_proxy` | Rolling forced-order volume — `feature-schema.ts` (liquidation_volume_30s) |
| ✅ | `funding_extreme_flag` | Funding > 2 std — `feature-schema.ts` |

---

### 16.3 Label Builder

| Status | Task | Notes |
|--------|------|-------|
| ✅ | **Direction labels** | `y_direction_{h}s` for 5/30/60/300s horizons — `label_builder.py` vectorized `np.select` |
| ✅ | **Regression labels** | `y_reg_{h}s = clip(future_return, ±50bps)` — `label_builder.py` |
| ✅ | **Volatility labels** | `y_vol_{h}s = realized_vol(next N seconds)` — forward-looking std of log-returns |
| ✅ | **Regime labels** | `label_regime` 0=chop/1=trend/2=high-vol — rule-based from `trend_slope` + `rv_1m` |
| ✅ | **Leakage guard** | `validate_no_leakage()` — checks feature names vs label prefixes + correlation guard |
| ✅ | **Cost-adjusted labels** | `y_tradeable_{h}s` — subtracts round-trip taker fee + slippage; only valid if edge survives |
| ✅ | **Multi-horizon labeling** | All labels generated for [5, 30, 60, 300] seconds in single `build_labels()` pass |

---

### 16.4 Data Pipeline Architecture

| Status | Component | Notes |
|--------|-----------|-------|
| ✅ | **Rolling feature builder** | `feature-schema.ts` + `buildFeatureVector()` merges all signal snapshots |
| ✅ | **Feature normalization** | `feature-normalizer.ts` — per-feature rolling z-score (Welford online) with ±5σ winsorization |
| ✅ | **Stream alignment** | `stream-aligner.ts` — `StreamAligner` tracks per-stream timestamps, `isAligned(maxSkewMs)`, `stalestStream()` |
| ✅ | **Stale-state guard** | `stale-guard.ts` — `StaleGuard` with `markFresh()`, `anyStale()`; wired into orchestrator heartbeat |
| ✅ | **Feature vector snapshot** | `feature-recorder.ts` — serialize normalized feature rows to CSV with daily rotation |
| ✅ | **Label join** | `ml_bot/label_builder.py` — direction/volatility labels at 5s/30s/60s horizons |
| ✅ | **Walk-forward splits** | `ml_bot/train.py` — chronological 80/20 split, never shuffle |
| ✅ | **OI poll integration** | `oi-poll-integrator.ts` — polls `/fapi/v1/openInterest` every 7s; `interpolateAt(ts)`, `latestDelta(windowSec)` |

---

### 16.5 Model Architecture

#### Phase 1 — Tabular Baseline (build first)

| Status | Task | Notes |
|--------|------|-------|
| ✅ | **LightGBM direction classifier** | `train.py train_direction()` — 54-feature classifier with early stopping, expanded feature set |
| ✅ | **LightGBM volatility regressor** | `train.py train_volatility()` — predicts 60s forward realized vol, MAE/R² reporting |
| ✅ | **Feature importance analysis** | `train.py shap_analysis()` — TreeExplainer SHAP, multi-class support, saves CSV |
| ✅ | **Walk-forward validation** | `train.py walk_forward_validation()` — rolling window train/test, per-fold accuracy + mean |

#### Phase 2 — Sequence Models

| Status | Task | Notes |
|--------|------|-------|
| ☐ | **TCN (Temporal Convolutional Network)** | Rolling window of raw orderbook + flow + OHLCV features; good first sequence model |
| ☐ | **LSTM / GRU** | Baseline RNN for comparison with TCN |
| ☐ | **Transformer encoder** | Self-attention over feature sequence; best for complex cross-feature patterns |
| ☐ | **Compare vs LightGBM baseline** | Sequence model only justified if it beats baseline after costs |

#### Phase 3 — Multimodal Ensemble

| Status | Task | Notes |
|--------|------|-------|
| ☐ | **OHLCV encoder branch** | Multi-TF candle features → dense embedding |
| ☐ | **Order book encoder branch** | Depth snapshots / deltas → embedding |
| ☐ | **OI / funding encoder branch** | OI delta, funding z-score, mark basis → embedding |
| ☐ | **Fusion layer** | Concatenate branch embeddings → direction + volatility + regime heads |
| ☐ | **Regime gating** | Regime head output gates whether direction head is acted upon |
| ☐ | **Execution quality head** | Separate head for slippage / adverse-move probability |

---

### 16.6 Live Inference Engine

| Status | Component | Notes |
|--------|-----------|-------|
| ✅ | **ONNX / TorchScript export** | `export_onnx.py` — loads `.pkl`, exports via `onnxmltools`, validates output matches original |
| ✅ | **Inference server** | `ml_bot/inference_server.py` — FastAPI `/infer` endpoint |
| ✅ | **Model output schema** | `model-types.ts` — `ModelOutput { p_up, p_down, p_flat }` |
| ✅ | **Threshold gate** | `ml-gate.ts` — `mlDecide()` with probability + chop + edge checks |
| ✅ | **Model versioning** | `model_version` in `ModelOutput` + `PredictionRecord`; `model_registry.py` JSON manifest; `inference-client.ts` parses version |
| ✅ | **Fallback to rule-based** | `inference-client.ts` circuit breaker → falls back to SMC when server unavailable |

---

### 16.7 Decision Logic Integration

```
p_up = model.p_up
p_down = model.p_down
regime = model.regime
expected_return = model.expected_return
expected_slippage = model.expected_slippage

IF p_up > 0.65
AND regime NOT IN [chop, low_liq]
AND expected_return > taker_fee + expected_slippage + MIN_EDGE_BPS
AND OI/orderbook/trade-flow confirm direction    ← existing SMC signals
THEN enter long

IF p_down > 0.65
AND regime NOT IN [chop, low_liq]
AND expected_return > taker_fee + expected_slippage + MIN_EDGE_BPS
AND OI/orderbook/trade-flow confirm direction
THEN enter short
```

| Status | Task | Notes |
|--------|------|-------|
| ✅ | **Replace naked signal entries** | ML gate wraps SMC signal in `orchestrator.ts evaluate()` behind `ML_ENABLED` + `ML_SHADOW_MODE` |
| ✅ | **Dynamic sizing from volatility forecast** | `volatility-sizer.ts` — `volatilitySizedPosition()` scales inversely to expected vol; wired into `runMlGate()` |
| ✅ | **Hold-time optimization** | `hold-time-optimizer.ts` — `optimalHoldTimeMs()` adapts to regime + expected return; stored on orchestrator |
| ✅ | **Execution model gating** | `execution-gate.ts` — `shouldSkipEntry()` blocks on wide spread, thin book, vol regime + gap; wired into `runMlGate()` |

---

### 16.8 Training & Retraining Pipeline

| Status | Task | Notes |
|--------|------|-------|
| ✅ | **Offline training script** | `ml_bot/train.py` — load CSVs → label → LightGBM → classification report → export .pkl |
| ✅ | **Walk-forward harness** | `ml_bot/train.py` — chronological 80/20 split with early stopping |
| ✅ | **Concept drift detection** | `drift_detector.py` — PSI-based per-feature drift detection; `compute_psi()`, `check_drift()`, `is_drifted()` |
| ✅ | **Scheduled retraining** | `retrain_scheduler.py` — `should_retrain()` + `retrain_if_due()` with walk-forward gate on min Sharpe |
| ✅ | **Model registry** | `model_registry.py` — JSON manifest with metadata (train period, schema version, metrics, active flag) |
| ✅ | **Shadow mode testing** | `ML_SHADOW_MODE=true` — logs predictions without overriding SMC decisions |

---

### 16.9 Post-Trade Analytics Loop

| Status | Task | Notes |
|--------|------|-------|
| ✅ | **Prediction vs outcome log** | `prediction-logger.ts` — CSV with `(timestamp, model_output, signal, actual_outcome)` |
| ✅ | **Calibration check** | `analytics/calibration.py` — bins by p_up decile, computes actual win rate, calibration error |
| ✅ | **Feature drift report** | `analytics/feature_drift.py` — training vs live distribution PSI, drift flags per feature |
| ✅ | **Signal decay tracking** | `analytics/signal_decay.py` — rolling accuracy over time windows, linear regression slope for trend detection |
| ✅ | **PnL attribution by model** | `analytics/pnl_attribution.py` — splits PnL into signal, regime filter, and execution quality components |

---

### 16.10 Updated Build Order (AI/ML additions)

#### P1 — Foundational ✅
- ✅ Feature builder: `feature-schema.ts` (40+ columns from all signal sources)
- ✅ Rolling z-score normalization: `feature-normalizer.ts` (Welford online, ±5σ winsorize)
- ✅ Feature snapshot serialization: `feature-recorder.ts` (CSV with daily rotation)

#### P2 — Baseline Model ✅
- ✅ Label builder: `ml_bot/label_builder.py` (direction/regression/vol/regime/fill/slippage/adverse + cost-adjusted + leakage guard)
- ✅ LightGBM training script: `ml_bot/train.py` (direction + vol + fill + slippage + adverse + walk-forward + SHAP)
- ✅ LightGBM volatility regressor for dynamic sizing
- ✅ SHAP feature importance

#### P3 — Live Inference ✅
- ✅ ONNX model export: `ml_bot/export_onnx.py`
- ✅ Inference service: `ml_bot/inference_server.py` (FastAPI `/infer` — direction, vol, fill, slippage, adverse)
- ✅ Probability gate: `ml-gate.ts` wraps SMC in orchestrator
- ✅ Model output schema: `model-types.ts` + threshold config in `config.ts`
- ✅ Shadow mode: `ML_SHADOW_MODE=true` default

#### P4 — Sequence & Ensemble (deferred — needs real data + Phase 1 baseline results)
- ☐ TCN / Transformer sequence model
- ☐ Multimodal encoder architecture
- ✅ Execution quality head (fill/slippage/adverse models built)
- ✅ Scheduled retraining pipeline: `retrain_scheduler.py`
- ✅ Concept drift monitoring: `drift_detector.py`

---

## 17. Concrete Implementation Blueprint

Production-ready skeletons. Wire these in order.

---

### 17.1 Final Feature Schema (exact columns, 1-row = 1 timestamp)

```
timestamp          # Unix ms
symbol             # e.g. BTCUSDT

# ── Prices ────────────────────────────────────────────────
mid_price
bid_price
ask_price
spread             # ask - bid

# ── Order book ────────────────────────────────────────────
obi_5              # (bid_vol_5 - ask_vol_5) / (bid_vol_5 + ask_vol_5)
obi_10
obi_20
bid_vol_5          # sum qty top-5 bids
ask_vol_5          # sum qty top-5 asks
depth_slope        # volume-weighted price gradient bid side
microprice         # (ask_px × bid_vol + bid_px × ask_vol) / (bid_vol + ask_vol)
book_pressure      # Σ(bid_vol / dist_from_mid) - Σ(ask_vol / dist_from_mid)

# ── Trade flow ────────────────────────────────────────────
trade_imbalance_1s # buy_vol - sell_vol over 1 s window
trade_imbalance_5s
trade_intensity_1s # trade count per second
vwap_5s            # volume-weighted avg price last 5 s
last_trade_dir     # +1 buy / -1 sell

# ── OHLCV multi-timeframe ─────────────────────────────────
ret_1s             # log(price_t / price_t-1s)
ret_5s
ret_1m
ret_5m
vol_1m             # rolling std of 1 s log-returns over 60 s
vol_5m
candle_body_1m     # abs(close - open) / (high - low)
wick_ratio_1m      # (high - close) / range  [upper wick]

# ── OI / derivatives ──────────────────────────────────────
oi                 # raw open interest contracts
oi_delta_1m        # oi_t - oi_t-60s
oi_zscore          # (oi_delta - rolling_mean) / rolling_std

# ── Funding / mark ────────────────────────────────────────
funding_rate       # current funding rate
funding_zscore     # (funding - 24h_mean) / 24h_std
mark_price
basis              # mark_price - mid_price

# ── Regime helpers ────────────────────────────────────────
rv_1m              # realized volatility 1 m
rv_5m              # realized volatility 5 m
vol_regime_flag    # 1 if rv_1m > 2 × rv_5m rolling mean
trend_strength     # abs(ret_5m) / vol_5m  (signal-to-noise)
```

**Engineering rules:**
- Normalize each column with per-symbol rolling z-score (window = 1000 rows)
- Winsorize at ±5 σ before feeding to model
- Align all streams to a common clock tick (e.g. every 1 s on the second boundary)
- Fill OI gaps with last known value (poll latency)

---

### 17.2 Label Specification

```python
HORIZONS = [5, 30, 60]   # seconds
THRESHOLD_BPS = 4        # 4 bps = 0.0004

for h in HORIZONS:
    df[f"future_return_{h}s"] = (
        df["mid_price"].shift(-h) - df["mid_price"]
    ) / df["mid_price"]

    def label_direction(x):
        if x >  THRESHOLD_BPS / 10_000: return  1   # UP
        if x < -THRESHOLD_BPS / 10_000: return -1   # DOWN
        return 0                                      # FLAT

    df[f"y_{h}s"] = df[f"future_return_{h}s"].apply(label_direction)

# Volatility label
df["y_vol_30s"] = df["mid_price"].transform(
    lambda s: s.pct_change().rolling(30).std().shift(-30)
)

# Cost-adjusted: strip trades where edge < fees + slippage before training
TAKER_FEE_BPS = 4   # 0.04% each side = 8 bps round-trip
df["tradeable"] = df["future_return_30s"].abs() > TAKER_FEE_BPS * 2 / 10_000
```

| Label | Target | Horizon | Threshold |
|-------|--------|---------|-----------|
| `y_5s` | direction | 5 s | ±4 bps |
| `y_30s` | direction | 30 s | ±4 bps |
| `y_1m` | direction | 60 s | ±4 bps |
| `y_vol_30s` | realized vol | 30 s | regression |
| `y_slippage` | fill cost | execution | regression |
| `y_adverse_move` | post-fill drawdown | 5 s after fill | regression |

---

### 17.3 Training Pipeline (Python, offline)

```python
# train.py
import pandas as pd
import numpy as np
import lightgbm as lgb
import joblib
from sklearn.metrics import classification_report

FEATURE_COLS = [
    "spread", "obi_5", "obi_10", "microprice", "book_pressure",
    "trade_imbalance_1s", "trade_imbalance_5s", "trade_intensity_1s",
    "ret_1s", "ret_5s", "ret_1m", "ret_5m", "vol_1m", "vol_5m",
    "candle_body_1m", "wick_ratio_1m",
    "oi_delta_1m", "oi_zscore",
    "funding_zscore", "basis",
    "rv_1m", "rv_5m", "vol_regime_flag", "trend_strength",
]
TARGET = "y_30s"

df = pd.read_parquet("features_labeled.parquet")
df = df[df["tradeable"]].dropna(subset=FEATURE_COLS + [TARGET])

# Walk-forward split (never shuffle)
split = int(len(df) * 0.8)
X_train, X_val = df[FEATURE_COLS].iloc[:split], df[FEATURE_COLS].iloc[split:]
y_train, y_val = df[TARGET].iloc[:split],        df[TARGET].iloc[split:]

model = lgb.LGBMClassifier(
    n_estimators=1000,
    max_depth=6,
    learning_rate=0.02,
    num_leaves=63,
    subsample=0.8,
    colsample_bytree=0.8,
    class_weight="balanced",   # handles imbalanced flat class
)
model.fit(
    X_train, y_train,
    eval_set=[(X_val, y_val)],
    callbacks=[lgb.early_stopping(50), lgb.log_evaluation(100)],
)

print(classification_report(y_val, model.predict(X_val)))
joblib.dump(model, "model_direction_30s.pkl")
```

---

### 17.4 Live Feature Builder (Python, async)

```python
# feature_engine.py
import numpy as np
from collections import deque

class FeatureEngine:
    WINDOW = 60  # seconds of 1 s ticks

    def __init__(self):
        self.prices   = deque(maxlen=self.WINDOW)
        self.buy_vol  = deque(maxlen=5)   # 1 s buckets
        self.sell_vol = deque(maxlen=5)
        self.oi_hist  = deque(maxlen=60)

    # ── called on every aggTrade event ──────────────────────────────
    def on_trade(self, price: float, qty: float, is_buy: bool):
        self.prices.append(price)
        if is_buy: self.buy_vol.append(qty)
        else:      self.sell_vol.append(qty)

    # ── called on every OI poll ──────────────────────────────────────
    def on_oi(self, oi: float):
        self.oi_hist.append(oi)

    # ── called every 1 s to produce one feature row ─────────────────
    def snapshot(self, ob: dict) -> dict | None:
        if len(self.prices) < 2:
            return None

        prices = np.array(self.prices)
        rets   = np.diff(np.log(prices))

        bids = sorted(ob["bids"].items(), reverse=True)[:20]
        asks = sorted(ob["asks"].items())[:20]

        bid_vol5 = sum(q for _, q in bids[:5])
        ask_vol5 = sum(q for _, q in asks[:5])
        total5   = bid_vol5 + ask_vol5 + 1e-9
        obi5     = (bid_vol5 - ask_vol5) / total5

        bid_px = bids[0][0] if bids else 0.0
        ask_px = asks[0][0] if asks else 0.0
        bid_vol_top = bids[0][1] if bids else 0.0
        ask_vol_top = asks[0][1] if asks else 0.0
        microprice  = (ask_px * bid_vol_top + bid_px * ask_vol_top) / (bid_vol_top + ask_vol_top + 1e-9)

        buy_v  = sum(self.buy_vol)
        sell_v = sum(self.sell_vol)
        tfi1s  = buy_v - sell_v

        rv1m = float(np.std(rets[-60:])) if len(rets) >= 60 else 0.0
        ret1m = float(np.sum(rets[-60:])) if len(rets) >= 60 else 0.0

        oi_delta = 0.0
        oi_zscore = 0.0
        if len(self.oi_hist) >= 2:
            deltas = np.diff(list(self.oi_hist))
            oi_delta  = float(deltas[-1])
            oi_zscore = float((oi_delta - deltas.mean()) / (deltas.std() + 1e-9))

        return {
            "spread":             ask_px - bid_px,
            "obi_5":              obi5,
            "microprice":         microprice,
            "trade_imbalance_1s": tfi1s,
            "ret_1m":             ret1m,
            "vol_1m":             rv1m,
            "oi_delta_1m":        oi_delta,
            "oi_zscore":          oi_zscore,
            # ... remaining cols filled similarly
        }
```

---

### 17.5 Inference Server (FastAPI, Python)

```python
# inference_server.py
from fastapi import FastAPI
import joblib, numpy as np

app   = FastAPI()
model = joblib.load("model_direction_30s.pkl")

FEATURE_ORDER = [
    "spread", "obi_5", "obi_10", "microprice", "book_pressure",
    "trade_imbalance_1s", "trade_imbalance_5s", "trade_intensity_1s",
    "ret_1s", "ret_5s", "ret_1m", "ret_5m", "vol_1m", "vol_5m",
    "candle_body_1m", "wick_ratio_1m",
    "oi_delta_1m", "oi_zscore",
    "funding_zscore", "basis",
    "rv_1m", "rv_5m", "vol_regime_flag", "trend_strength",
]

@app.post("/infer")
def infer(body: dict):
    x = np.array([[body["features"][f] for f in FEATURE_ORDER]])
    probs = model.predict_proba(x)[0]
    classes = model.classes_   # [-1, 0, 1]
    p = dict(zip(classes.tolist(), probs.tolist()))
    return {
        "p_down": p.get(-1, 0.0),
        "p_flat": p.get( 0, 0.0),
        "p_up":   p.get( 1, 0.0),
    }
```

---

### 17.6 TypeScript Inference Client

```typescript
// src/ai/inference-client.ts

export interface ModelOutput {
  p_up:   number;
  p_down: number;
  p_flat: number;
}

export async function infer(features: Record<string, number>): Promise<ModelOutput> {
  const res = await fetch("http://localhost:8000/infer", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ features }),
  });
  if (!res.ok) throw new Error(`inference HTTP ${res.status}`);
  return res.json() as Promise<ModelOutput>;
}
```

---

### 17.7 Decision Gate (wire into orchestrator.ts)

```typescript
// src/engine/ml-gate.ts
import { infer, ModelOutput } from "../ai/inference-client.js";

const MIN_P       = 0.65;
const MIN_EDGE    = 0.0008;  // 8 bps after fees
const TAKER_ROUND = 0.0008;  // 4 bps each side

export async function mlDecide(
  features: Record<string, number>,
  smcSignal: "LONG" | "SHORT" | null,
): Promise<"LONG" | "SHORT" | null> {
  const { p_up, p_down, p_flat } = await infer(features);

  const regime_chop = p_flat > 0.50;
  if (regime_chop) return null;

  const expected_return = Math.max(p_up, p_down) * MIN_EDGE;
  if (expected_return < TAKER_ROUND + MIN_EDGE) return null;

  if (p_up > MIN_P && smcSignal === "LONG")   return "LONG";
  if (p_down > MIN_P && smcSignal === "SHORT") return "SHORT";
  return null;
}
```

---

### 17.8 End-to-End Live Pipeline

```
WS streams (depth@100ms + aggTrade + markPrice@1s)
  │
  ▼
FeatureEngine.on_trade() / on_oi()         ← Python or TS
  │   every 1 s:
  ▼
FeatureEngine.snapshot()  →  feature row
  │
  ▼
POST http://localhost:8000/infer
  │
  ▼
{ p_up, p_down, p_flat }
  │
  ▼
mlDecide(features, smcSignal)              ← gate: p > 0.65 + regime + edge
  │
  ▼
ExecutionEngine.execute(signal, qty)
  │
  ▼
Store (feature_row, model_output, outcome) ← post-trade loop
```

---

### 17.9 Latency Budget

| Stage | Target |
|-------|--------|
| WS ingestion | < 0.5 ms |
| Feature snapshot | < 0.3 ms |
| HTTP inference (localhost) | < 1.0 ms |
| Decision gate | < 0.1 ms |
| Order send | < 0.5 ms |
| **Total** | **~2 ms** |

Upgrade path: replace HTTP inference with ONNX runtime via native binding → sub-100 µs.

---

### 17.10 Evaluation Checklist (do not skip)

| Metric | Minimum bar to deploy |
|--------|-----------------------|
| Precision on `y_30s ≠ 0` | > 52% |
| Walk-forward Sharpe | > 1.0 after fees |
| Max drawdown (validation) | < 15% |
| Win rate | > 50% on tradeable subset |
| Cost-adjusted hit rate | Must beat flat-prediction baseline |
| Calibration | Predicted p_up deciles match actual win rates ± 5% |

---

## 18. Python ML Bot — Standalone Service

A dedicated Python process that runs alongside the TypeScript execution engine.
TypeScript owns execution + WebSocket ingestion; Python owns feature building, training, and inference.
They communicate over HTTP (inference server) and optionally Redis (shared state).

---

### 18.1 Project Structure

```
ml_bot/
├── config.py
├── main.py                    # async event loop
├── ingestion/
│   └── ws_client.py           # WS multiplexer (depth + aggTrade + bookTicker)
├── engine/
│   ├── orderbook.py           # stateful L2 book with diff sync
│   ├── features.py            # rolling feature builder
│   └── state.py               # shared mutable trading state
├── model/
│   └── inference.py           # load model, predict_proba → structured output
├── strategy/
│   ├── decision.py            # threshold gate + regime filter
│   └── risk.py                # position sizing + daily loss cap
├── execution/
│   └── binance.py             # aiohttp signed REST client
└── utils/
    └── ringbuffer.py          # Float64 ring buffer, no allocs
```

---

### 18.2 config.py

```python
SYMBOL = "btcusdt"

WS_STREAMS = [
    f"{SYMBOL}@depth@100ms",
    f"{SYMBOL}@aggTrade",
    f"{SYMBOL}@bookTicker",
    f"{SYMBOL}@markPrice@1s",
]

API_KEY    = "YOUR_KEY"
API_SECRET = "YOUR_SECRET"
BASE_URL   = "https://fapi.binance.com"

TRADE_THRESHOLD = 0.65   # min model probability to act
MIN_EDGE_BPS    = 8      # minimum edge after fees (round-trip ~8 bps)
MAX_POSITION    = 0.01   # max BTC notional
MAX_DAILY_LOSS  = 0.03   # 3 % of equity → kill switch
```

---

### 18.3 ingestion/ws_client.py

```python
import asyncio, websockets, orjson
from config import WS_STREAMS

URL = "wss://fstream.binance.com/stream?streams=" + "/".join(WS_STREAMS)

async def start_ws(queue: asyncio.Queue):
    while True:
        try:
            async with websockets.connect(URL, ping_interval=20) as ws:
                async for msg in ws:
                    await queue.put(orjson.loads(msg))
        except Exception as exc:
            print(f"WS error, reconnecting: {exc}")
            await asyncio.sleep(2)
```

---

### 18.4 engine/orderbook.py

```python
class OrderBook:
    def __init__(self):
        self.bids: dict[float, float] = {}
        self.asks: dict[float, float] = {}

    def update(self, data: dict):
        for p, q in data["b"]:
            p, q = float(p), float(q)
            if q == 0: self.bids.pop(p, None)
            else:      self.bids[p] = q
        for p, q in data["a"]:
            p, q = float(p), float(q)
            if q == 0: self.asks.pop(p, None)
            else:      self.asks[p] = q

    def top(self) -> tuple[float, float]:
        bid = max(self.bids) if self.bids else 0.0
        ask = min(self.asks) if self.asks else 0.0
        return bid, ask
```

> **TODO:** Add snapshot-sync state machine (track `U`/`u` update IDs) so the book is
> correct after reconnect — same logic as `order-book-sync.ts` in the TS codebase.

---

### 18.5 engine/features.py

```python
import numpy as np
from collections import deque

class FeatureEngine:
    def __init__(self, window: int = 60):
        self.prices    = deque(maxlen=window)
        self.buy_vol   = deque(maxlen=window)
        self.sell_vol  = deque(maxlen=window)

    def on_trade(self, price: float, qty: float, is_maker_sell: bool):
        self.prices.append(price)
        if is_maker_sell: self.sell_vol.append(qty)  # aggressor = buyer
        else:             self.buy_vol.append(qty)   # aggressor = seller

    def compute(self, ob: "OrderBook") -> dict | None:
        bid, ask = ob.top()
        if bid == 0 or ask == 0:
            return None

        mid    = (bid + ask) / 2
        spread = ask - bid

        bids_sorted = sorted(ob.bids.items(), reverse=True)[:10]
        asks_sorted = sorted(ob.asks.items())[:10]
        bid_vol = sum(q for _, q in bids_sorted[:5])
        ask_vol = sum(q for _, q in asks_sorted[:5])
        obi5    = (bid_vol - ask_vol) / (bid_vol + ask_vol + 1e-9)

        bid_vol_top = bids_sorted[0][1] if bids_sorted else 0.0
        ask_vol_top = asks_sorted[0][1] if asks_sorted else 0.0
        microprice  = (ask * bid_vol_top + bid * ask_vol_top) / (bid_vol_top + ask_vol_top + 1e-9)

        tfi_1s = sum(self.buy_vol) - sum(self.sell_vol)

        prices = np.array(self.prices)
        rets   = np.diff(np.log(prices)) if len(prices) > 1 else np.array([0.0])
        vol1m  = float(np.std(rets[-60:])) if len(rets) >= 60 else 0.0
        ret1m  = float(np.sum(rets[-60:])) if len(rets) >= 60 else 0.0

        return {
            "spread":             spread,
            "obi_5":              obi5,
            "microprice":         microprice,
            "trade_imbalance_1s": tfi_1s,
            "ret_1m":             ret1m,
            "vol_1m":             vol1m,
            # extend with full schema from Section 17.1
        }
```

---

### 18.6 model/inference.py

```python
import joblib, numpy as np

FEATURE_ORDER = [
    "spread", "obi_5", "microprice",
    "trade_imbalance_1s", "ret_1m", "vol_1m",
    # must match training column order exactly
]

class Model:
    def __init__(self, path: str = "model_direction_30s.pkl"):
        self.clf = joblib.load(path)

    def predict(self, features: dict) -> dict:
        x     = np.array([[features[f] for f in FEATURE_ORDER]])
        probs = self.clf.predict_proba(x)[0]
        p     = dict(zip(self.clf.classes_.tolist(), probs.tolist()))
        return {
            "p_down": p.get(-1, 0.0),
            "p_flat": p.get( 0, 0.0),
            "p_up":   p.get( 1, 0.0),
        }
```

---

### 18.7 strategy/decision.py

```python
from config import TRADE_THRESHOLD, MIN_EDGE_BPS

TAKER_ROUND_BPS = 8   # 4 bps each side

def decide(pred: dict, vol1m: float) -> str:
    if pred["p_flat"] > 0.50:           return "HOLD"   # chop regime
    if vol1m > 0.002:                   return "HOLD"   # high-vol guard
    edge = max(pred["p_up"], pred["p_down"]) * MIN_EDGE_BPS
    if edge < TAKER_ROUND_BPS + MIN_EDGE_BPS: return "HOLD"

    if pred["p_up"]   > TRADE_THRESHOLD: return "LONG"
    if pred["p_down"] > TRADE_THRESHOLD: return "SHORT"
    return "HOLD"
```

---

### 18.8 strategy/risk.py

```python
from config import MAX_POSITION, MAX_DAILY_LOSS

class RiskManager:
    def __init__(self, equity: float):
        self.position   = 0.0
        self.daily_loss = 0.0
        self.equity     = equity
        self.killed     = False

    def check_kill(self) -> bool:
        if self.daily_loss / self.equity > MAX_DAILY_LOSS:
            self.killed = True
        return self.killed

    def size(self, signal: str) -> float:
        if self.killed:                 return 0.0
        if signal == "HOLD":            return 0.0
        if signal == "LONG":
            return min(MAX_POSITION, MAX_POSITION - self.position)
        return -min(MAX_POSITION, MAX_POSITION + self.position)

    def record_pnl(self, pnl: float):
        if pnl < 0: self.daily_loss += abs(pnl)
```

---

### 18.9 execution/binance.py

```python
import time, hmac, hashlib
import aiohttp
from config import API_KEY, API_SECRET, BASE_URL

def _sign(params: dict) -> str:
    qs  = "&".join(f"{k}={v}" for k, v in params.items())
    sig = hmac.new(API_SECRET.encode(), qs.encode(), hashlib.sha256).hexdigest()
    return f"{qs}&signature={sig}"

async def place_order(session: aiohttp.ClientSession, symbol: str, side: str, qty: float) -> dict:
    params = {
        "symbol":   symbol.upper(),
        "side":     "BUY" if side == "LONG" else "SELL",
        "type":     "MARKET",
        "quantity": round(qty, 3),
        "timestamp": int(time.time() * 1000),
    }
    qs = _sign(params)
    async with session.post(
        f"{BASE_URL}/fapi/v1/order?{qs}",
        headers={"X-MBX-APIKEY": API_KEY},
    ) as res:
        return await res.json()
```

---

### 18.10 main.py

```python
import asyncio
import aiohttp
from ingestion.ws_client import start_ws
from engine.orderbook    import OrderBook
from engine.features     import FeatureEngine
from model.inference     import Model
from strategy.decision   import decide
from strategy.risk       import RiskManager
from execution.binance   import place_order
from config              import SYMBOL

async def main():
    queue    = asyncio.Queue()
    ob       = OrderBook()
    features = FeatureEngine()
    model    = Model()
    risk     = RiskManager(equity=1000.0)

    asyncio.create_task(start_ws(queue))

    async with aiohttp.ClientSession() as session:
        while True:
            msg    = await queue.get()
            stream = msg.get("stream", "")
            data   = msg.get("data", {})

            if "depth"    in stream: ob.update(data)
            if "aggTrade" in stream:
                features.on_trade(
                    float(data["p"]), float(data["q"]),
                    is_maker_sell=data["m"],
                )

            fvec = features.compute(ob)
            if not fvec:
                continue

            if risk.check_kill():
                print("KILL SWITCH ACTIVE — no new trades")
                continue

            pred   = model.predict(fvec)
            signal = decide(pred, fvec["vol_1m"])
            qty    = risk.size(signal)

            if qty != 0:
                print(f"TRADE {signal} qty={abs(qty):.4f}  p_up={pred['p_up']:.2f}")
                result = await place_order(session, SYMBOL, signal, abs(qty))
                print("ORDER:", result)

if __name__ == "__main__":
    asyncio.run(main())
```

---

### 18.11 Production Hardening Checklist

| Status | Item |
|--------|------|
| ☐ | Replace `dict`-based orderbook with sorted array (faster top-N) |
| ☐ | Add orderbook snapshot sync (U/u update-ID tracking) |
| ☐ | `clientOrderId` per order for idempotent retries |
| ☐ | Exponential backoff on 429 / 5xx |
| ☐ | User-data stream for `ORDER_TRADE_UPDATE` (don't poll order state) |
| ☐ | Private listenKey keep-alive (PUT every 30 min) |
| ☐ | `countdownCancelAll` keepalive to auto-cancel on crash |
| ☐ | Prometheus metrics endpoint |
| ☐ | Structured JSON logging |
| ☐ | Dockerfile + `systemd` / `supervisor` unit file |
| ☐ | Deploy to AWS `ap-southeast-1` (Singapore) for lowest Binance latency |

---

### 18.12 Dependencies

```
pip install websockets orjson aiohttp lightgbm numpy joblib
```

For inference server (optional):
```
pip install fastapi uvicorn
```

For ONNX upgrade:
```
pip install onnxruntime skl2onnx
```

---

## 19. PnL Dashboard + Monitoring System

Separates the bot from a production system.
Architecture: Bot → PostgreSQL + Redis + Prometheus → FastAPI backend → Next.js frontend.

---

### 19.1 What to Track

#### Trading metrics
| Status | Metric | Notes |
|--------|--------|-------|
| ☐ | Realized PnL (running total) | Sum of closed trade PnL |
| ☐ | Unrealized PnL | Current open position mark-to-market |
| ☐ | Equity curve | Cumulative PnL time-series |
| ☐ | Drawdown | Peak-to-trough in equity, max and current |
| ☐ | Win rate | Winning trades / total trades |
| ☐ | Avg win / avg loss | Profit factor = avg_win / avg_loss |
| ☐ | Sharpe ratio | Rolling 7-day / 30-day |

#### Execution metrics
| Status | Metric | Notes |
|--------|--------|-------|
| ☐ | Order send latency | Time from signal to REST response |
| ☐ | Fill latency | Time from REST response to `ORDER_TRADE_UPDATE` |
| ☐ | Slippage bps | Fill price vs microprice at order time |
| ☐ | Fill rate | Filled / placed (market = ~100%; limit may miss) |

#### Model metrics
| Status | Metric | Notes |
|--------|--------|-------|
| ☐ | p_up / p_down distributions | Histogram every N minutes |
| ☐ | Confidence histogram | How often model is above threshold |
| ☐ | Live prediction accuracy | Compare model label vs actual outcome |
| ☐ | Feature drift | Rolling mean/std vs training baseline |

#### System metrics
| Status | Metric | Notes |
|--------|--------|-------|
| ☐ | WS message lag | Time between Binance event and processing |
| ☐ | Queue depth | Backlog in async queue |
| ☐ | CPU / memory | Per-process |
| ☐ | Errors per minute | Uncaught exceptions, API errors |
| ☐ | WS reconnects | Count per hour |

---

### 19.2 PostgreSQL Schema

```sql
-- Closed trades
CREATE TABLE trades (
    id           SERIAL PRIMARY KEY,
    timestamp    BIGINT NOT NULL,
    symbol       TEXT   NOT NULL,
    side         TEXT   NOT NULL,         -- LONG / SHORT
    qty          FLOAT  NOT NULL,
    entry_price  FLOAT  NOT NULL,
    exit_price   FLOAT  NOT NULL,
    pnl          FLOAT  NOT NULL,
    fee          FLOAT  NOT NULL,
    close_reason TEXT,                    -- TP / SL / REVERSAL / KILL
    strategy     TEXT DEFAULT 'smc_ml'
);

-- Open / closed positions snapshot
CREATE TABLE positions (
    symbol          TEXT PRIMARY KEY,
    qty             FLOAT NOT NULL,
    entry_price     FLOAT NOT NULL,
    unrealized_pnl  FLOAT NOT NULL DEFAULT 0,
    updated_at      BIGINT NOT NULL
);

-- ML prediction log (for calibration and drift)
CREATE TABLE predictions (
    timestamp  BIGINT NOT NULL,
    symbol     TEXT   NOT NULL,
    p_up       FLOAT  NOT NULL,
    p_down     FLOAT  NOT NULL,
    p_flat     FLOAT  NOT NULL,
    mid_price  FLOAT  NOT NULL,
    signal     TEXT,                     -- LONG / SHORT / HOLD
    actual_y   INT                       -- filled in post-hoc: +1 / -1 / 0
);

-- Equity snapshots (for curve chart)
CREATE TABLE equity_snapshots (
    timestamp      BIGINT PRIMARY KEY,
    equity         FLOAT NOT NULL,
    drawdown       FLOAT NOT NULL,
    open_positions INT   NOT NULL
);
```

---

### 19.3 Bot → DB Logging

```python
# monitoring/db.py
import asyncpg, time

async def get_pool(dsn: str) -> asyncpg.Pool:
    return await asyncpg.create_pool(dsn)

async def log_trade(pool, trade: dict):
    await pool.execute("""
        INSERT INTO trades
            (timestamp, symbol, side, qty, entry_price, exit_price, pnl, fee, close_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    """, int(time.time()*1000), trade["symbol"], trade["side"],
        trade["qty"], trade["entry_price"], trade["exit_price"],
        trade["pnl"], trade["fee"], trade.get("reason"))

async def log_prediction(pool, pred: dict, mid: float, signal: str):
    await pool.execute("""
        INSERT INTO predictions (timestamp, symbol, p_up, p_down, p_flat, mid_price, signal)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
    """, int(time.time()*1000), pred["symbol"],
        pred["p_up"], pred["p_down"], pred["p_flat"], mid, signal)

async def snapshot_equity(pool, equity: float, drawdown: float, open_pos: int):
    await pool.execute("""
        INSERT INTO equity_snapshots VALUES ($1,$2,$3,$4)
        ON CONFLICT (timestamp) DO NOTHING
    """, int(time.time()*1000), equity, drawdown, open_pos)
```

---

### 19.4 Prometheus Metrics (bot side)

```python
# monitoring/metrics.py
from prometheus_client import start_http_server, Gauge, Counter, Histogram

pnl_gauge        = Gauge("bot_pnl_usdt",         "Total realized PnL in USDT")
equity_gauge     = Gauge("bot_equity_usdt",       "Current equity")
drawdown_gauge   = Gauge("bot_drawdown_pct",      "Current drawdown fraction")
trades_counter   = Counter("bot_trades_total",    "Total trades placed", ["side"])
errors_counter   = Counter("bot_errors_total",    "Errors", ["type"])
order_latency    = Histogram("bot_order_latency_ms", "Order send latency ms",
                             buckets=[1, 2, 5, 10, 25, 50, 100, 250, 500])
inference_lat    = Histogram("bot_inference_latency_ms", "ML inference latency ms",
                             buckets=[0.1, 0.5, 1, 2, 5, 10])

def start_metrics_server(port: int = 9000):
    start_http_server(port)
```

---

### 19.5 FastAPI Backend

```python
# dashboard/api.py
from fastapi import FastAPI, WebSocket
import asyncpg, asyncio

app  = FastAPI()
pool: asyncpg.Pool = None
_ws_clients: list[WebSocket] = []

@app.on_event("startup")
async def startup():
    global pool
    pool = await asyncpg.create_pool("postgresql://postgres:pass@localhost/bot")

@app.get("/pnl")
async def get_pnl():
    row = await pool.fetchrow("SELECT COALESCE(SUM(pnl),0) AS total FROM trades")
    return {"pnl": row["total"]}

@app.get("/trades")
async def get_trades(limit: int = 100):
    rows = await pool.fetch(
        "SELECT * FROM trades ORDER BY timestamp DESC LIMIT $1", limit)
    return [dict(r) for r in rows]

@app.get("/equity")
async def get_equity():
    rows = await pool.fetch(
        "SELECT timestamp, equity, drawdown FROM equity_snapshots ORDER BY timestamp")
    return [dict(r) for r in rows]

@app.get("/metrics/model")
async def model_metrics():
    rows = await pool.fetch("""
        SELECT DATE_TRUNC('minute', TO_TIMESTAMP(timestamp/1000)) AS minute,
               AVG(p_up) AS avg_p_up, AVG(p_down) AS avg_p_down
        FROM predictions
        WHERE timestamp > EXTRACT(EPOCH FROM NOW()-INTERVAL '1 hour')*1000
        GROUP BY 1 ORDER BY 1
    """)
    return [dict(r) for r in rows]

@app.websocket("/ws")
async def ws_live(ws: WebSocket):
    await ws.accept()
    _ws_clients.append(ws)
    try:
        while True:
            await asyncio.sleep(1)   # keep alive; bot pushes via broadcast()
    except Exception:
        _ws_clients.remove(ws)

async def broadcast(event: dict):
    dead = []
    for c in _ws_clients:
        try: await c.send_json(event)
        except Exception: dead.append(c)
    for c in dead: _ws_clients.remove(c)
```

---

### 19.6 Alert System

```python
# monitoring/alerts.py
import aiohttp, os

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
TELEGRAM_CHAT  = os.getenv("TELEGRAM_CHAT_ID")
SLACK_WEBHOOK  = os.getenv("SLACK_WEBHOOK")

async def send_telegram(msg: str):
    if not TELEGRAM_TOKEN: return
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    async with aiohttp.ClientSession() as s:
        await s.post(url, json={"chat_id": TELEGRAM_CHAT, "text": msg})

async def send_slack(msg: str):
    if not SLACK_WEBHOOK: return
    async with aiohttp.ClientSession() as s:
        await s.post(SLACK_WEBHOOK, json={"text": msg})

async def alert(msg: str):
    await send_telegram(msg)
    await send_slack(msg)

# Usage in risk manager:
# if drawdown > MAX_DAILY_LOSS: await alert(f"⚠️ Kill switch triggered. Drawdown={drawdown:.1%}")
# if ws_lag_ms > 2000:          await alert(f"⚠️ WS lag spike: {ws_lag_ms}ms")
```

---

### 19.7 Next.js Frontend Skeleton

```bash
npx create-next-app@latest dashboard --ts
cd dashboard
npm install recharts swr
```

```typescript
// pages/index.tsx
import useSWR from "swr";
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

const fetcher = (url: string) => fetch(url).then(r => r.json());

export default function Dashboard() {
  const { data: pnl }    = useSWR("http://localhost:8001/pnl",    fetcher, { refreshInterval: 2000 });
  const { data: equity } = useSWR("http://localhost:8001/equity", fetcher, { refreshInterval: 5000 });
  const { data: trades } = useSWR("http://localhost:8001/trades", fetcher, { refreshInterval: 2000 });

  return (
    <main style={{ padding: 24, background: "#0d1117", color: "#e6edf3", minHeight: "100vh" }}>
      <h1>Trading Bot Dashboard</h1>

      {/* PnL summary */}
      <section>
        <h2>Realized PnL: {pnl?.pnl?.toFixed(2)} USDT</h2>
      </section>

      {/* Equity curve */}
      <section>
        <h2>Equity Curve</h2>
        <LineChart width={900} height={300} data={equity ?? []}>
          <CartesianGrid strokeDasharray="3 3" stroke="#30363d" />
          <XAxis dataKey="timestamp" tickFormatter={t => new Date(t).toLocaleTimeString()} />
          <YAxis />
          <Tooltip />
          <Line type="monotone" dataKey="equity" stroke="#00ff99" dot={false} />
          <Line type="monotone" dataKey="drawdown" stroke="#ff4444" dot={false} yAxisId="right" />
        </LineChart>
      </section>

      {/* Recent trades */}
      <section>
        <h2>Recent Trades</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>{["Time","Symbol","Side","Qty","Entry","Exit","PnL","Reason"].map(h =>
              <th key={h} style={{ padding: 8, borderBottom: "1px solid #30363d" }}>{h}</th>
            )}</tr>
          </thead>
          <tbody>
            {(trades ?? []).map((t: any) => (
              <tr key={t.id} style={{ color: t.pnl >= 0 ? "#00ff99" : "#ff4444" }}>
                <td>{new Date(t.timestamp).toLocaleTimeString()}</td>
                <td>{t.symbol}</td>
                <td>{t.side}</td>
                <td>{t.qty}</td>
                <td>{t.entry_price?.toFixed(2)}</td>
                <td>{t.exit_price?.toFixed(2)}</td>
                <td>{t.pnl?.toFixed(4)}</td>
                <td>{t.close_reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
```

---

### 19.8 Deployment Stack

```yaml
# docker-compose.yml  (skeleton)
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: bot
      POSTGRES_PASSWORD: pass
    volumes: [pgdata:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine

  prometheus:
    image: prom/prometheus
    volumes: [./prometheus.yml:/etc/prometheus/prometheus.yml]

  grafana:
    image: grafana/grafana
    ports: ["3001:3000"]
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin

  api:
    build: ./dashboard
    command: uvicorn api:app --host 0.0.0.0 --port 8001
    depends_on: [postgres]

  dashboard:
    build: ./dashboard/frontend
    ports: ["3000:3000"]
    environment:
      NEXT_PUBLIC_API: http://api:8001

volumes:
  pgdata:
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: trading_bot
    static_configs:
      - targets: ["host.docker.internal:9000"]
```

---

### 19.9 Grafana Panels

| Panel | Query |
|-------|-------|
| Realized PnL | `bot_pnl_usdt` |
| Equity | `bot_equity_usdt` |
| Drawdown | `bot_drawdown_pct * 100` |
| Trades/min | `rate(bot_trades_total[1m])` |
| Order latency P95 | `histogram_quantile(0.95, bot_order_latency_ms_bucket)` |
| Inference latency P95 | `histogram_quantile(0.95, bot_inference_latency_ms_bucket)` |
| Error rate | `rate(bot_errors_total[1m])` |

---

### 19.10 Alert Rules

| Condition | Action |
|-----------|--------|
| `drawdown > MAX_DAILY_LOSS` | Telegram + Slack: kill switch triggered |
| `ws_lag_ms > 2000` | Telegram: WS latency spike |
| `order_latency_p95 > 500 ms` | Slack: execution slow |
| `bot_errors_total rate > 5/min` | Telegram: error storm |
| `bot_pnl_usdt < −N` | Telegram: absolute loss threshold hit |
| Bot process silent > 60 s | External watchdog → force-close all + alert |

---

## 20. Testnet / Mainnet Environment Hardening

Core switching is already implemented (`BINANCE_FUTURES_TESTNET`, `binanceRestBase`, `binanceWsBase`,
WS API testnet URL). The gaps below are safety and workflow items.

### 20.1 What's Already Done

| Feature | Location |
|---------|----------|
| `BINANCE_FUTURES_TESTNET` flag | `config.ts:216` |
| REST URL routing | `config.ts:360` — `https://testnet.binancefuture.com` |
| Public WS URL routing | `config.ts:367` — `wss://fstream.binancefuture.com` |
| WS API URL routing | `futures-ws-api.ts:21` — `wss://testnet.binancefuture.com/ws-fapi/v1` |
| `.env.example` key-swap documentation | `.env.example:119–129` |
| Safe paper default | `EXECUTION_MODE=paper`, `READ_ONLY=true` |

### 20.2 Missing Safety & Workflow Items

| Status | Item | Notes |
|--------|------|-------|
| ☐ | **Environment validation on startup** | If `BINANCE_FUTURES_TESTNET=false` and `EXECUTION_MODE=live`, log a loud warning and require explicit `CONFIRMED_LIVE=true` env var to proceed — prevents accidental mainnet live orders during development |
| ☐ | **Shadow mode flag** (`SHADOW_MODE=true`) | Connect to mainnet data streams but suppress ALL order placement at the adapter level regardless of `EXECUTION_MODE`; log what *would* have been sent. Different from `READ_ONLY` (which is adapter-level, not enforced centrally). Needed for Phase 3 of the deployment workflow. |
| ☐ | **Shadow prediction log** | When `SHADOW_MODE=true`, record every signal with timestamp, direction, and the actual price outcome N seconds later for offline accuracy measurement |
| ☐ | **Max notional cap for Phase 4** | `MAX_NOTIONAL_USDT` env var that hard-caps order size regardless of risk engine output; set to e.g. 50 USDT during first live week |
| ☐ | **`demo-fapi.binance.com` support** | Config comment mentions it but URL is not wired in; add as a third option (`BINANCE_PRODUCT=usdm_demo`) for the Binance portfolio margin demo environment |
| ☐ | **Testnet liquidity warning** | Log a startup notice when `BINANCE_FUTURES_TESTNET=true` reminding that fills and slippage are not realistic and paper results will not transfer directly to mainnet |

### 20.3 Four-Phase Deployment Checklist

```
Phase 1 — Backtesting (offline)
  ✘ Backtest engine not built (see §17)
  Action: build kline-replay engine, train LightGBM on historical data

Phase 2 — Testnet paper trading
  ✔ BINANCE_FUTURES_TESTNET=true
  ✔ EXECUTION_MODE=paper (simulated fills, no real orders)
  ✔ Use testnet API keys from testnet.binancefuture.com
  ✘ Shadow prediction log not built (see §20.2)
  Action: run full pipeline, verify execution latency, fill logic, risk controls

Phase 3 — Shadow mode on mainnet
  ✘ SHADOW_MODE flag not built (see §20.2)
  ✔ BINANCE_FUTURES_TESTNET=false  (real market data)
  Action: SHADOW_MODE=true, compare model signals vs actual market moves for N days

Phase 4 — Live trading (small capital)
  ✔ BINANCE_FUTURES_TESTNET=false
  ✔ EXECUTION_MODE=live, READ_ONLY=false, BINANCE_EXECUTION_ADAPTER=true
  ✘ MAX_NOTIONAL_USDT cap not built (see §20.2)
  ✘ CONFIRMED_LIVE guard not built (see §20.2)  ← ✅ NOW DONE (CONFIRMED_LIVE_TRADING in config.ts)
  Action: set MAX_NOTIONAL_USDT=50, monitor PnL dashboard, raise slowly
```

> ✅ **Implemented (this session):** `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` env vars,
> `binanceApiCredentials()` helper, `CONFIRMED_LIVE_TRADING` safety guard in `create-runtime.ts`,
> and `.env.example` updated with inline warnings.

---

## 21. Redis Event Bus + Multi-Service Docker Architecture

Current state: single-process Node.js bot with an in-process WS bridge for the browser UI.
Goal: decouple ingestion, strategy, execution, and UI into separate services connected via Redis.

### 21.1 Target Architecture

```
Binance WS (depth + aggTrade + markPrice)
        │
        ▼
┌─────────────────┐
│  Bot Engine     │  TypeScript — ingestion + features + strategy + execution
│  (this repo)    │
└──────┬──────────┘
       │  redis.publish("ticks" / "signals" / "orders" / "positions")
       ▼
┌─────────────────┐
│  Redis          │  pub/sub channels + streams (time-series) + state keys
│  - pub/sub      │
│  - XADD streams │
│  - HSET state   │
└──────┬──────────┘
       │  sub.subscribe("ticks" / "signals")
       ▼
┌─────────────────┐
│  WS Gateway     │  fanout to browser clients (replaces current in-process bridge)
│  (Node server)  │
└──────┬──────────┘
       │  WebSocket
       ▼
┌─────────────────┐
│  Dashboard UI   │  Next.js / React (currently: plain HTML + Vite)
└─────────────────┘
```

### 21.2 Redis Channel Design

| Status | Channel / Key | Producer | Consumer | Contents |
|--------|--------------|----------|----------|---------|
| ☐ | `ticks` (pub/sub) | Bot engine | WS gateway, ML service | `{ symbol, price, ts }` |
| ☐ | `signals` (pub/sub) | Strategy engine | Execution engine, dashboard | `{ symbol, direction, confidence, ts }` |
| ☐ | `orders` (pub/sub) | Execution engine | Dashboard, audit log | `{ orderId, side, qty, price, ts }` |
| ☐ | `positions` (pub/sub) | `ORDER_TRADE_UPDATE` handler | Dashboard, risk engine | position state delta |
| ☐ | `price_stream` (XADD) | Bot engine | ML feature store, backtester | rolling tick time-series |
| ☐ | `orderbook_stream` (XADD) | Orderbook engine | ML feature store | L2 snapshot per N ms |
| ☐ | `state:position:<sym>` (HSET) | Execution engine | Risk engine, restart recovery | current open position |
| ☐ | `state:balance` (HSET) | `ACCOUNT_UPDATE` handler | Risk engine, dashboard | wallet balance |
| ☐ | `state:kill_switch` (SET) | Risk engine / operator | All services | `"1"` = halt all trading |

### 21.3 Bot Engine — Redis Publisher

```typescript
// src/redis/publisher.ts
import Redis from 'ioredis';

export class BotPublisher {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async publishTick(symbol: string, price: number) {
    const payload = JSON.stringify({ symbol, price, ts: Date.now() });
    await this.redis.publish('ticks', payload);
    await this.redis.xadd('price_stream', '*', 'symbol', symbol, 'price', String(price));
  }

  async publishSignal(signal: { symbol: string; direction: string; confidence: number }) {
    await this.redis.publish('signals', JSON.stringify({ ...signal, ts: Date.now() }));
  }

  async setPosition(symbol: string, position: object) {
    await this.redis.hset(`state:position:${symbol}`, position as Record<string, string>);
  }

  async isKillSwitchActive(): Promise<boolean> {
    return (await this.redis.get('state:kill_switch')) === '1';
  }
}
```

### 21.4 WS Gateway — Redis Subscriber → Browser

```typescript
// ws-gateway/index.ts
import WebSocket, { WebSocketServer } from 'ws';
import Redis from 'ioredis';

const sub = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const wss = new WebSocketServer({ port: 4000 });

const channels = ['ticks', 'signals', 'orders', 'positions'];
sub.subscribe(...channels);

sub.on('message', (_channel: string, message: string) => {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));
});
```

### 21.5 Docker Compose (full system)

```yaml
# docker-compose.yml
services:
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    volumes: [redis_data:/data]
    command: redis-server --save 60 1 --loglevel warning

  bot:
    build: .
    env_file: .env
    environment:
      REDIS_URL: redis://redis:6379
    depends_on: [redis]
    restart: unless-stopped

  ws-gateway:
    build: ./ws-gateway
    ports: ["4000:4000"]
    environment:
      REDIS_URL: redis://redis:6379
    depends_on: [redis]
    restart: unless-stopped

  ui:
    build: ./ui
    ports: ["3000:3000"]
    environment:
      NEXT_PUBLIC_WS_URL: ws://ws-gateway:4000
    depends_on: [ws-gateway]

  prometheus:
    image: prom/prometheus
    volumes: [./prometheus.yml:/etc/prometheus/prometheus.yml]
    ports: ["9090:9090"]

  grafana:
    image: grafana/grafana
    ports: ["3001:3000"]
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin

volumes:
  redis_data:
```

### 21.6 Kill Switch via Redis

```typescript
// Any process can halt all trading instantly:
await redis.set('state:kill_switch', '1');

// Bot engine checks before every signal execution:
if (await publisher.isKillSwitchActive()) {
  logger.warn('kill switch active — skipping signal');
  return;
}

// CLI reset:
// redis-cli SET state:kill_switch 0
```

### 21.7 Implementation Tasks

| Status | Task | Notes |
|--------|------|-------|
| ☐ | `src/redis/publisher.ts` | BotPublisher class (tick + signal + position publish) |
| ☐ | Wire publisher into orchestrator | Call `publishTick` on each aggTrade, `publishSignal` on each strategy output |
| ☐ | Kill switch check in orchestrator | `isKillSwitchActive()` before executing any signal |
| ☐ | `ws-gateway/` service | Redis subscriber → WebSocket fanout (replace current in-process bridge) |
| ☐ | `docker-compose.yml` | Full system: redis + bot + ws-gateway + ui + prometheus + grafana |
| ☐ | `Dockerfile` for bot | `node:22-alpine`, non-root user, health check |
| ☐ | Redis position state | Write open position to `state:position:<sym>` on open/close |
| ☐ | Redis balance state | Write balance to `state:balance` on `ACCOUNT_UPDATE` |
| ☐ | Startup state recovery | On bot restart, read `state:position:*` from Redis before subscribing WS |
| ☐ | `REDIS_URL` env var | Add to `config.ts` + `.env.example`; default `redis://localhost:6379` |
