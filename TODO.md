# TODO — Binance USDⓈ-M Futures Production Trading System

Gaps between the current codebase and the full production-grade spec.
Items marked ✅ are already implemented.

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
| ☐ | `PUT /fapi/v1/order` | **Modify Order** — amend price/qty in-place instead of cancel+resubmit |
| ☐ | `POST /fapi/v1/batchOrders` | **Place Multiple Orders** — atomic multi-leg entries |
| ☐ | `PUT /fapi/v1/batchOrders` | **Modify Multiple Orders** |
| ☐ | `DELETE /fapi/v1/batchOrders` | **Cancel Multiple Orders** |
| ☐ | `POST /fapi/v1/countdownCancelAll` | **Auto-Cancel All** — dead-man countdown; cancel all if keepalive stops |
| ☐ | `GET /fapi/v1/order` | **Query Order** by `orderId` or `clientOrderId` |
| ☐ | `GET /fapi/v1/openOrders` | **All Open Orders** for a symbol |
| ☐ | `GET /fapi/v1/allOrders` | **Full Order History** |
| ☐ | `GET /fapi/v1/userTrades` | **Trade List** — reconciliation and PnL attribution |
| ☐ | `GET /fapi/v1/algoOrder` | **Query Algo Order** by `algoId` |
| ☐ | `POST /fapi/v1/order/test` | **Test New Order** — validate filters without execution |

---

## 2. REST API — Account / Risk / Config

| Status | Endpoint | Notes |
|--------|----------|-------|
| ✅ | `GET /fapi/v2/account` | Account info |
| ✅ | `GET /fapi/v2/balance` | Asset balances |
| ✅ | `GET /fapi/v2/positionRisk` | Per-symbol position state |
| ☐ | `GET /fapi/v1/commissionRate` | **User Commission Rate** — use real taker/maker rates instead of config constants |
| ☐ | `GET /fapi/v1/accountConfig` | **Account Configuration** — position mode, asset mode |
| ☐ | `GET /fapi/v1/symbolConfig` | **Symbol Configuration** — per-symbol leverage limits |
| ☐ | `GET /fapi/v1/leverageBracket` | **Notional & Leverage Brackets** — accurate liquidation price and max notional per tier |
| ☐ | `GET /fapi/v1/multiAssetsMargin` | **Multi-Assets Mode** — detect if portfolio margin is active |
| ☐ | `GET /fapi/v1/positionSide/dual` | **Position Mode** — detect hedge mode vs one-way; required for dual-side orders |
| ☐ | `GET /fapi/v1/rateLimit/order` | **Order Rate Limit** — track remaining order quota to prevent 429s |
| ☐ | `GET /fapi/v1/income` | **Income History** — realized PnL, fees, funding flows for reconciliation |

---

## 3. REST API — Market Data

| Status | Endpoint | Notes |
|--------|----------|-------|
| ✅ | `GET /fapi/v1/exchangeInfo` | Tick/step precision |
| ✅ | `GET /fapi/v1/depth` | Orderbook snapshot |
| ✅ | `GET /fapi/v1/klines` | Historical candles |
| ✅ | `GET /fapi/v1/premiumIndex` | Mark price + funding rate |
| ☐ | `GET /fapi/v1/ticker/bookTicker` | **REST Best Bid/Ask** — snapshot fallback when WS is unavailable |
| ☐ | `GET /fapi/v1/ticker/24hr` | **24h Ticker Stats** — REST fallback |
| ☐ | `GET /fapi/v1/fundingRate` | **Funding Rate History** — used for funding cost prediction |
| ☐ | `GET /fapi/v1/trades` | **Recent Trades** |
| ☐ | `GET /fapi/v1/historicalTrades` | **Historical Trades** |
| ☐ | `GET /fapi/v1/openInterest` | **Current Open Interest** — poll every 5–10 s for OI signals |
| ☐ | `GET /futures/data/openInterestHist` | **OI Statistics History** — 5m/15m/1h/1d intervals |

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
| ☐ | `<symbol>@miniTicker` | **Mini Ticker** — lightweight 24h stats for watchlist symbols |
| ☐ | `!ticker@arr` | **All-symbol Ticker Array** — global market scan |
| ☐ | `!miniTicker@arr` | **All-symbol Mini Ticker Array** |
| ☐ | `!bookTicker` | **All-symbol Best Bid/Ask** — multi-symbol execution anchor |
| ☐ | `!forceOrder@arr` | **All-symbol Liquidation Stream** — global liquidation cascade detection |
| ☐ | `!contractInfo` | **Contract Info Stream** — live symbol listing/delisting events |

---

## 5. Private User-Data Stream Events

| Status | Event | Notes |
|--------|-------|-------|
| ✅ | `ORDER_TRADE_UPDATE` | Fill + order lifecycle |
| ✅ | `ACCOUNT_UPDATE` | Balance + position changes |
| ✅ | `MARGIN_CALL` | Margin warning |
| ☐ | `TRADE_LITE` | **Trade Lite** — lower-bandwidth fill notification |
| ☐ | `ACCOUNT_CONFIG_UPDATE` | **Account Config Update** — leverage or margin mode change by user |
| ☐ | `ALGO_ORDER_UPDATE` | **Algo Order Update** — TP/SL trigger / status changes from Algo Service |
| ☐ | `CONDITIONAL_ORDER_TRIGGER_REJECT` | **Conditional Reject** — alert when TP/SL fails to trigger |
| ☐ | `STRATEGY_UPDATE` | **Strategy Update** — grid/strategy order state |
| ☐ | `GRID_UPDATE` | **Grid Update** — grid trading order events |
| ☐ | Listen-key expiry handling | **Auto-renew + reconnect** when listenKey expires; currently keep-alive exists but expiry event is not handled |

---

## 6. WebSocket API (Trading over WS)

| Status | Method | Notes |
|--------|--------|-------|
| ✅ | `session.logon` | Ed25519 auth implemented |
| ✅ | `order.place` | WS order placement |
| ✅ | `order.cancel` | WS order cancel |
| ✅ | `algoOrder.place` | WS algo order |
| ✅ | `algoOrder.cancel` | WS algo cancel |
| ☐ | `session.status` | **Session Status** — heartbeat/auth check |
| ☐ | `session.logout` | **Session Logout** — clean teardown |
| ☐ | `order.modify` | **Modify Order** — amend via WS instead of REST round-trip |
| ☐ | `order.status` | **Query Order** via WS |

---

## 7. Risk Engine

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Position sizing (USDT-native) | Capital × leverage / entry |
| ✅ | TP/SL percentage targets | Configurable via env |
| ✅ | Paper liquidation engine | Maintenance margin model |
| ☐ | **Drawdown kill switch** | Pause/close-all when daily loss exceeds threshold (e.g. 3% equity) |
| ☐ | **Max open positions limit** | Hard cap on concurrent live positions across symbols |
| ☐ | **Volatility-adjusted sizing** | ATR-based quantity scaling instead of fixed USDT amount |
| ☐ | **Spread guard** | Reject entry when bid-ask spread exceeds max bps |
| ☐ | **Rate-limit circuit breaker** | Halt order flow when order-count approaches Binance limit (from `/fapi/v1/rateLimit/order`) |
| ☐ | **Leverage bracket validation** | Cross-check position notional against `leverageBracket` tiers before entry |
| ☐ | **Time-based session filter** | Skip low-liquidity windows (e.g. weekend late-night) |
| ☐ | **Cross-symbol correlation guard** | Prevent adding same-direction exposure on highly correlated symbols simultaneously |
| ☐ | **countdownCancelAll integration** | Wire POST `/fapi/v1/countdownCancelAll` as bot-level dead-man switch |

---

## 8. Execution Engine

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Market order entry | Long/Short |
| ✅ | Algo TP1 / TP2 / SL | Via Algo Service |
| ✅ | Precision rounding | tick/step size |
| ✅ | Reduce-only close orders | Via closePosition flag |
| ☐ | **Batch order submission** | Use `POST /fapi/v1/batchOrders` for atomic entry + bracket in one request |
| ☐ | **Modify order in-place** | `PUT /fapi/v1/order` / `order.modify` instead of cancel+resubmit |
| ☐ | **Post-only limit entry** | LIMIT with `timeInForce=GTX` for maker fills and lower fees |
| ☐ | **Trailing stop** | `TRAILING_STOP_MARKET` order type |
| ☐ | **Hedge mode support** | Dual position side (`LONG`/`SHORT`) when `positionSide/dual` is enabled |
| ☐ | **clientOrderId deduplication** | Idempotent retry: detect duplicate fills via `clientOrderId` before re-sending |
| ☐ | **Exponential backoff retry** | Structured retry with jitter on 429/5xx; currently basic reconnect exists |
| ☐ | **Post-execution slippage log** | Compare fill price vs microprice at time of order |

---

## 9. Market Microstructure Features

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Order Book Imbalance (OBI) | Top-N bid/ask volume ratio |
| ✅ | AggTrade tape | Ring buffer of recent trades |
| ☐ | **Trade Flow Imbalance (TFI)** | Buy vol − Sell vol over rolling window; `trade.m` (maker side) already available in tape |
| ☐ | **Weighted OBI** | Level-distance weighting: closer levels count more |
| ☐ | **Microprice** | `(ask_px × bid_vol + bid_px × ask_vol) / (bid_vol + ask_vol)` — better than mid |
| ☐ | **Order Flow Imbalance (OFI)** | Δbid_size − Δask_size per depth diff event |
| ☐ | **Depth pressure** | Σ(bid_vol / price_dist) − Σ(ask_vol / price_dist) |
| ☐ | **Rolling realized volatility** | √Σ(log-return²) over 1 s / 5 s / 1 m windows |
| ☐ | **Liquidation cascade signal** | `!forceOrder@arr` aggregate: large forced volume → momentum signal |
| ☐ | **Open Interest delta** | OI change rate: rising OI + rising price = trend confirmation |
| ☐ | **Funding rate pressure** | Elevated funding → crowded side; use as contrarian or momentum filter |

---

## 10. Multi-Timeframe Feature Pipeline

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Candle aggregation (1m → higher TF) | MultiTfStore |
| ✅ | 5-TF SMC confluence scoring | daily/h4/h1/m15/m5 |
| ☐ | **1 s / 5 s micro aggregates** | Sub-minute feature windows for microstructure signals |
| ☐ | **Rolling feature vectors** | Structured `Float64Array` ring buffers per feature per window |
| ☐ | **Feature normalization layer** | z-score / min-max for ML input |
| ☐ | **Multi-symbol feature bus** | Unified feature snapshot across watchlist for cross-asset signals |

---

## 11. Persistence & State

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Paper wallet JSON (atomic write) | Balance + margin snapshot |
| ✅ | Paper ledger JSONL | ClosedPosition append log |
| ✅ | NDJSON app logger | Structured log stream |
| ☐ | **PostgreSQL / ClickHouse** | Durable storage for orders, trades, positions, features |
| ☐ | **Redis hot state** | Sub-ms read for active position, OBI, last price across processes |
| ☐ | **Order replay on restart** | Re-fetch open orders via `GET /fapi/v1/openOrders` + algo orders; rebuild in-memory state fully |
| ☐ | **Income reconciliation** | Periodic sync via `GET /fapi/v1/income` to verify realized PnL matches ledger |
| ☐ | **Trade attribution** | Tag closed trades with entry signal, SMC zone, and HTF bias for analysis |

---

## 12. Observability & Monitoring

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | NDJSON + stdout logger | Heartbeat every 60 s |
| ✅ | Real-time dashboard (WS bridge) | Browser UI for market data + signals |
| ☐ | **Prometheus metrics export** | Orders placed/filled, latency histograms, PnL gauge, WS reconnects |
| ☐ | **Grafana dashboard** | Visualize metrics from Prometheus |
| ☐ | **Alert webhooks** | Slack/email/Telegram on: margin call, kill-switch trigger, WS down > N s |
| ☐ | **Order latency tracking** | Measure send-time → `ORDER_TRADE_UPDATE` roundtrip; P95/P99 per session |
| ☐ | **Fill quality report** | Fill price vs microprice at order time; slippage variance log |
| ☐ | **Equity curve snapshot** | Periodic equity + drawdown time-series to DB |
| ☐ | **External watchdog** | Separate process that pings bot heartbeat; force-closes all positions if silent > N s |

---

## 13. Backtesting & Research

| Status | Feature | Notes |
|--------|---------|-------|
| ☐ | **Backtest engine** | Replay historical klines + orderbook snapshots through strategy + execution pipeline |
| ☐ | **WS stream recorder** | Record raw WS frames to disk for replay |
| ☐ | **Walk-forward validation** | Out-of-sample parameter validation (prevent curve-fitting) |
| ☐ | **Parameter sweep** | Grid or Bayesian search over `MIN_CONFIDENCE`, `MIN_SMC_SCORE`, `TP_PRICE_PCT`, etc. |
| ☐ | **PnL attribution reports** | Win rate, avg hold time, profit factor by signal / TF / session |
| ☐ | **Execution quality simulator** | Model fill price, slippage, and queue position in backtest |

---

## 14. Infrastructure & Scalability

| Status | Feature | Notes |
|--------|---------|-------|
| ✅ | Single-symbol live trading | SOL/ETH/BTC |
| ✅ | Watchlist multi-symbol market data | Feed ingestion only |
| ☐ | **Multi-symbol live execution** | Concurrent position management across watchlist symbols |
| ☐ | **Config hot-reload** | Reload env/config without full process restart |
| ☐ | **Multi-account support** | Run separate strategy instances per API key |
| ☐ | **NATS / ZeroMQ message bus** | Decouple ingestion, strategy, and execution into separate processes |
| ☐ | **WS payload compression** | Enable `permessage-deflate` on WS connections |
| ☐ | **VPS co-location** | Deploy to AWS `ap-southeast-1` (Singapore) for minimal Binance round-trip latency |
| ☐ | **CPU affinity pinning** | Pin execution loop to isolated core (Linux `taskset`) |

---

## 15. Recommended Build Order (Priority)

### P0 — Correctness / Safety (do first)
1. `GET /fapi/v1/openOrders` + `GET /fapi/v1/userTrades` — complete state reconciliation on restart
2. `GET /fapi/v1/positionSide/dual` — prevent wrong-side order rejections in hedge mode accounts
3. `GET /fapi/v1/rateLimit/order` + rate-limit circuit breaker
4. `POST /fapi/v1/countdownCancelAll` — dead-man switch for unattended operation
5. Drawdown kill switch (daily loss cap → close-all + disable entries)
6. Listen-key expiry event handling
7. `ALGO_ORDER_UPDATE` + `CONDITIONAL_ORDER_TRIGGER_REJECT` private stream events

### P1 — Edge & Execution Quality
8. Trade Flow Imbalance (TFI) from existing AggTradeTape
9. Weighted OBI + Microprice
10. `PUT /fapi/v1/order` / `order.modify` — amend SL/TP in-place
11. `POST /fapi/v1/batchOrders` — atomic entry + bracket
12. `GET /fapi/v1/leverageBracket` — accurate liquidation price per notional tier
13. `GET /fapi/v1/income` — server-side PnL reconciliation
14. `GET /fapi/v1/commissionRate` — replace hardcoded fee constants

### P2 — Analytics & Research
15. `GET /fapi/v1/openInterest` polling + OI delta signal
16. `GET /futures/data/openInterestHist` for OI trend context
17. `GET /fapi/v1/fundingRate` history for funding cost model
18. `!forceOrder@arr` global liquidation stream
19. PostgreSQL persistence layer
20. Backtest engine (kline replay)

### P3 — Production Hardening
21. Prometheus metrics + Grafana
22. Alert webhooks (Slack/Telegram)
23. External watchdog process
24. Redis hot state cache
25. Multi-symbol live execution
26. Walk-forward parameter validation
