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

---

## 16. AI / ML Trading System

> Current state: only Ollama LLM advisory (`market-brief.ts`, `supertrend-tune.ts`).
> No feature pipeline, no label builder, no ML models, no live inference.

---

### 16.1 What to Predict (Model Targets)

| Status | Target | Notes |
|--------|--------|-------|
| ☐ | `P(return > +N bps in next T seconds)` | Direction classification — avoids noisy regression |
| ☐ | `P(return < −N bps in next T seconds)` | Down probability (independent head) |
| ☐ | `expected_return` over next N seconds | Clipped regression target |
| ☐ | `expected_volatility` over next N seconds | Realized vol forecast |
| ☐ | `regime` ∈ {trend, mean-revert, chop, high-vol, low-liq} | Controls whether alpha model should trade at all |
| ☐ | `fill_probability` | Will a limit order fill before adverse move? |
| ☐ | `slippage_bps` | Expected execution cost beyond spread |
| ☐ | `adverse_move_probability` | P(price moves against entry within T seconds of fill) |

---

### 16.2 Feature Schema

Every row in the training set and live inference vector should contain:

#### Microstructure features (strongest short-term signal)

| Status | Feature | Source |
|--------|---------|--------|
| ☐ | `spread` | Best ask − best bid |
| ☐ | `microprice` | `(ask_px × bid_vol + bid_px × ask_vol) / (bid_vol + ask_vol)` |
| ☐ | `obi_5` | Top-5 weighted bid/ask volume imbalance |
| ☐ | `obi_10` | Top-10 weighted bid/ask volume imbalance |
| ☐ | `weighted_depth_imbalance` | Level-distance weighted OBI |
| ☐ | `order_flow_imbalance` | Δbid_size − Δask_size per depth diff |
| ☐ | `book_slope_bid` / `book_slope_ask` | Volume-weighted price gradient |
| ☐ | `liquidity_gap` | Largest price gap in top-20 levels |
| ☐ | `cancel_intensity` | Rate of depth level removals |
| ☐ | `book_thinning` | Rolling decrease in total top-N depth volume |
| ☐ | `bid_wall_persistence` / `ask_wall_persistence` | How long large levels survive before cancellation |

#### Trade flow / aggression features

| Status | Feature | Source |
|--------|---------|--------|
| ☐ | `trade_imbalance_1s` / `5s` / `30s` | Buy vol − Sell vol (from `aggTrade.m`) |
| ☐ | `trade_intensity_1s` | Trade count per second |
| ☐ | `signed_volume_5s` | Net aggressor volume |
| ☐ | `burstiness` | Variance of inter-trade arrival times |
| ☐ | `last_trade_direction_streak` | Consecutive same-side trades |
| ☐ | `large_trade_flag` | Trade qty > N × rolling avg qty |

#### OHLCV / candle features

| Status | Feature | Source |
|--------|---------|--------|
| ☐ | `ret_1m` / `ret_5m` / `ret_15m` | Log returns at each TF |
| ☐ | `vol_1m` / `vol_5m` | Realized volatility (rolling std of log returns) |
| ☐ | `candle_body_pct` | `abs(close − open) / (high − low)` |
| ☐ | `wick_ratio_upper` / `wick_ratio_lower` | Wick size relative to range |
| ☐ | `volume_zscore_1m` | Volume vs rolling mean/std |
| ☐ | `range_expansion` | Current range vs N-bar avg range |
| ☐ | `trend_slope` | Linear regression slope over last N bars |
| ☐ | `momentum_5m` / `momentum_15m` | Close-to-close return over N bars |

#### Open interest / derivatives features

| Status | Feature | Source |
|--------|---------|--------|
| ☐ | `oi_delta_1m` | Change in OI over last minute |
| ☐ | `oi_delta_5m` | Change in OI over 5 min |
| ☐ | `oi_zscore` | OI delta z-score vs rolling window |
| ☐ | `price_oi_regime` | Encoded: price↑+OI↑ / price↑+OI↓ / price↓+OI↑ / price↓+OI↓ |
| ☐ | `oi_divergence` | OI direction opposing price direction |
| ☐ | `oi_spike` | OI change > N × rolling std |

#### Funding / mark price features

| Status | Feature | Source |
|--------|---------|--------|
| ☐ | `funding_zscore` | Current funding rate vs rolling 24h mean/std |
| ☐ | `mark_last_basis` | `(mark_price − last_trade_price) / last_trade_price` |
| ☐ | `liquidation_pressure_proxy` | Rolling forced-order volume from `@forceOrder` |
| ☐ | `funding_extreme_flag` | Funding > 2 std → crowded side signal |

---

### 16.3 Label Builder

| Status | Task | Notes |
|--------|------|-------|
| ☐ | **Direction labels** | `y = 1` if `future_return_30s > +4 bps`; `y = −1` if `< −4 bps`; else `0` — avoids noisy mid-zone |
| ☐ | **Regression labels** | `y = clip(future_return_Ns, −50bps, +50bps)` |
| ☐ | **Volatility labels** | `y = realized_vol(next N seconds)` |
| ☐ | **Regime labels** | Rule-based clustering initially: trend/chop/high-vol; learn from rules later |
| ☐ | **Leakage guard** | Never use any feature that includes data from after label horizon |
| ☐ | **Cost-adjusted labels** | Subtract taker fee + estimated slippage; if edge disappears, label is useless |
| ☐ | **Multi-horizon labeling** | Generate labels for 5 s, 30 s, 1 m, 5 m simultaneously from single pass |

---

### 16.4 Data Pipeline Architecture

| Status | Component | Notes |
|--------|-----------|-------|
| ☐ | **Rolling feature builder** | Per-event update of feature windows: 100 ms, 1 s, 5 s, 30 s, 1 m, 5 m, 15 m |
| ☐ | **Feature normalization** | Per-symbol rolling z-score (mean/std over sliding N-bar window) |
| ☐ | **Stream alignment** | All streams timestamped and aligned to common clock before feature join |
| ☐ | **Stale-state guard** | Mark book state stale if no depth update in > 500 ms; exclude from features |
| ☐ | **Feature vector snapshot** | Serialize full feature row at each bar/event to Parquet/ClickHouse |
| ☐ | **Label join** | After collection, join feature rows with forward-looking labels for each horizon |
| ☐ | **Walk-forward splits** | Chronological train/val/test split — never random shuffle |
| ☐ | **OI poll integration** | Poll `/fapi/v1/openInterest` every 5–10 s; interpolate to feature timestamps |

---

### 16.5 Model Architecture

#### Phase 1 — Tabular Baseline (build first)

| Status | Task | Notes |
|--------|------|-------|
| ☐ | **LightGBM direction classifier** | `P(up) / P(down) / P(flat)` on 30 s horizon; fastest path to usable alpha |
| ☐ | **LightGBM volatility regressor** | Predict next-1m realized vol for position sizing and regime detection |
| ☐ | **Feature importance analysis** | SHAP values to identify which features actually carry signal |
| ☐ | **Walk-forward validation** | Rolling window: train on T months, test on T+1; repeat across full history |

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
| ☐ | **ONNX / TorchScript export** | Export trained model for sub-100 µs inference without Python overhead |
| ☐ | **Inference server** | Thin async service: receive feature vector → return probability output in < 1 ms |
| ☐ | **Model output schema** | `{ p_up, p_down, p_chop, vol_regime, expected_return, expected_slippage }` — structured, not just "buy/sell" |
| ☐ | **Threshold gate** | `if p_up > 0.65 AND regime != chop AND expected_return > fees + slippage + buffer THEN enter` |
| ☐ | **Model versioning** | Track which model version produced each trade for post-trade attribution |
| ☐ | **Fallback to rule-based** | If inference latency spikes or model service is down, revert to existing SMC strategy |

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
| ☐ | **Replace naked signal entries** | Wrap existing SMC/trend strategy output with ML probability gate |
| ☐ | **Dynamic sizing from volatility forecast** | Scale `CAPITAL_PER_TRADE_USDT` down when `expected_volatility` is high |
| ☐ | **Hold-time optimization** | Use expected-return horizon to set max hold time before exit |
| ☐ | **Execution model gating** | Skip entry when `slippage_probability` is high (e.g. thin book, high vol regime) |

---

### 16.8 Training & Retraining Pipeline

| Status | Task | Notes |
|--------|------|-------|
| ☐ | **Offline training script** | Python: load Parquet features → normalize → label join → train → evaluate → export |
| ☐ | **Walk-forward harness** | Automate rolling train/test windows; report Sharpe / hit-rate / cost-adjusted PnL per fold |
| ☐ | **Concept drift detection** | Monitor live feature distribution vs training distribution; alert when gap exceeds threshold |
| ☐ | **Scheduled retraining** | Weekly / monthly retrain on newest N weeks of data; gate deployment on walk-forward passing min Sharpe |
| ☐ | **Model registry** | Store model artifacts with metadata (train period, feature schema version, validation metrics) |
| ☐ | **Shadow mode testing** | Run new model in parallel with no execution; compare signals vs live model before promoting |

---

### 16.9 Post-Trade Analytics Loop

| Status | Task | Notes |
|--------|------|-------|
| ☐ | **Prediction vs outcome log** | Store `(feature_vector, model_output, actual_outcome)` per trade |
| ☐ | **Calibration check** | Plot predicted `p_up` vs actual win rate at each decile |
| ☐ | **Feature drift report** | Rolling mean/std of each feature vs training baseline |
| ☐ | **Signal decay tracking** | Monitor if model accuracy degrades over time (common in alpha signals) |
| ☐ | **PnL attribution by model** | Split realized PnL into: model signal contribution vs execution quality vs market regime |

---

### 16.10 Updated Build Order (AI/ML additions)

#### P1 — Foundational (add to P1 queue)
- Feature builder for microstructure: TFI, weighted OBI, microprice, OFI, spread (feeds both existing strategy and future ML)
- Rolling z-score normalization layer
- Feature snapshot serialization to Parquet

#### P2 — Baseline Model
- Label builder (direction 30 s, volatility 1 m, multi-horizon)
- LightGBM direction classifier + walk-forward validation
- LightGBM volatility regressor for dynamic sizing
- SHAP feature importance

#### P3 — Live Inference
- ONNX model export
- Inference service (< 1 ms target)
- Probability gate wrapping existing execution engine
- Model output schema + threshold config
- Shadow mode harness

#### P4 — Sequence & Ensemble
- TCN / Transformer sequence model
- Multimodal encoder architecture
- Execution quality head (slippage / adverse-move model)
- Scheduled retraining pipeline
- Concept drift monitoring
