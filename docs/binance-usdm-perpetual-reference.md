# Binance USDⓈ-M perpetual futures — API reference

Scope: **USDⓈ-M (USDT-margined) perpetual contracts** on Binance Derivatives — market data, WebSockets, trading, account, funding, and algo orders.

Official hubs:
- [Derivatives documentation](https://developers.binance.com/docs/derivatives)
- [USD-M Futures general info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info)
- [WebSocket market streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams)
- [Trade REST](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api)
- [User Data Streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams)

---

## 1. Environments and base URLs

| Layer | Mainnet | Testnet |
|-------|---------|---------|
| **REST (USD-M)** | `https://fapi.binance.com` | `https://testnet.binancefuture.com` |
| **WebSocket (USD-M)** | Root `wss://fstream.binance.com` | `wss://fstream.binancefuture.com` |

Set `BINANCE_FUTURES_TESTNET=true` to switch to testnet. Override both endpoints individually with `BINANCE_REST_BASE` / `BINANCE_WS_BASE` if needed.

**Routed WebSocket paths** — Binance splits USD-M streams across two routes from the same root:
- `/market/stream` — klines, aggTrade, markPrice
- `/public/stream` — bookTicker, depth

`src/binance/ws-routing.ts` normalises `BINANCE_WS_BASE` to a root and builds the correct route per stream. Do not point `BINANCE_WS_BASE` at a routed path.

---

## 2. Market data — REST (`/fapi`)

All public endpoints; no API key required.

| Use | Endpoint | Notes |
|-----|----------|-------|
| Candles | `GET /fapi/v1/klines` | `symbol`, `interval`, `limit`, optional `startTime`/`endTime` |
| Order book | `GET /fapi/v1/depth` | Snapshot; maintain locally with WS `depth` diff |
| Trades | `GET /fapi/v1/trades`, `GET /fapi/v1/aggTrades` | Public recent trades |
| Ticker / 24h | `GET /fapi/v1/ticker/24hr`, `GET /fapi/v1/ticker/price` | Last / stats |
| Mark / funding | `GET /fapi/v1/premiumIndex`, `GET /fapi/v1/fundingRate` | Mark price, index, funding rate |
| Exchange info | `GET /fapi/v1/exchangeInfo` | Filters, tick/step size, contract specs |

**In this repo:**

| Source file | Covers |
|-------------|--------|
| `src/binance/rest-klines.ts` | `GET /fapi/v1/klines` (seeding + live bars) |
| `src/binance/rest-premium-index.ts` | `GET /fapi/v1/premiumIndex` (mark REST poll) |
| `src/binance/rest-depth.ts` | `GET /fapi/v1/depth` (orderbook bootstrap) |
| `src/binance/historical.ts` | Paginated multi-page kline pulls |
| `src/binance/rest-exchange-info.ts` | `GET /fapi/v1/exchangeInfo` → extracts `tickSize`, `stepSize`, `minQty` |

---

## 3. Market data — WebSocket (USD-M)

### 3.1 Stream names

| Stream | Purpose |
|--------|---------|
| `<sym>@kline_<interval>` | Candle updates; `k.x = true` = closed bar |
| `<sym>@markPrice@1s` | Mark price (USD-M perp) |
| `<sym>@aggTrade` | Aggregate trade tape |
| `<sym>@bookTicker` | Best bid/ask |
| `<sym>@depth<N>@<speed>` | Partial order book (N = 5/10/20) |
| `<sym>@depth@<speed>` | Diff depth stream (use with REST snapshot bootstrap) |
| `<sym>@forceOrder` | Liquidation events for this symbol |

### 3.2 Combined stream format

`{root}/{route}/stream?streams=a@aggTrade/b@kline_1m` — payload wrapped `{ "stream": "...", "data": { ... } }`.

### 3.3 Operational rules

- **Ping/pong:** server sends WebSocket ping frames; client must pong within the window or risk disconnect. Handled in `BinanceMultiplexWs`.
- **`serverShutdown`:** JSON event before maintenance; triggers immediate reconnect.
- **23h rotation timer:** pre-empts Binance's 24h connection cap (`BINANCE_WS_RECONNECT_HOURS=23`).
- **Exponential backoff reconnect:** cap 60s.

### 3.4 In this repo

`BinanceMultiplexWs` (`src/binance/ws-multiplex.ts`) subscribes all streams on a single combined connection per route. Callbacks:
- `onKline(symbol, tf, candle, isFinal)` → `MultiTimeframeStore`
- `onMarkPrice(update)` → mark reference + `positionManager.onMark()`
- `onAggTrade(event)` → `AggTradeTape`
- `onBookTicker(event)` → `BookTickerFeed` (paper fills)
- `onDepthDiff` / `onDepthPartial` → `LocalOrderBook`
- `onForceOrder(event)` → liquidation hook (when `BINANCE_USE_FORCE_ORDER=true`)

REST fallback: `USDM_MARK_REST_POLL_SEC` (default 5s) polls `GET /fapi/v1/premiumIndex` when `fstream` push frames are blocked.

---

## 4. Trading — REST (signed, `/fapi`)

Signing: **HMAC-SHA256** (`timestamp` + `signature` appended to every request). Implemented in `src/binance/rest-client.ts` (`BinanceRestClient`). Requires `BINANCE_API_KEY` + `BINANCE_API_SECRET`.

### 4.1 Order lifecycle

| Step | Endpoint | Notes |
|------|----------|-------|
| Set leverage | `POST /fapi/v1/leverage` | Called on every entry |
| Set margin type | `POST /fapi/v1/marginType` | `ISOLATED`; code -4046 = already set (ignored) |
| Entry | `POST /fapi/v1/order` | `type: MARKET`, `newOrderRespType: RESULT` for fill price |
| Cancel order | `DELETE /fapi/v1/order` | By `orderId` |
| Cancel all | `DELETE /fapi/v1/allOpenOrders` | Symbol-level batch cancel |
| Query open | `GET /fapi/v1/openOrders` | Optional symbol filter |
| Query single | `GET /fapi/v1/order` | By `orderId` |
| Batch place | `POST /fapi/v1/batchOrders` | Up to 5 orders |

### 4.2 Algo orders — TP/SL (Dec 2025 migration)

**`STOP_MARKET`, `TAKE_PROFIT_MARKET`, and `TRAILING_STOP_MARKET` must use the Algo Service**, not `/fapi/v1/order`.

| Step | Endpoint | Notes |
|------|----------|-------|
| Place algo order | `POST /fapi/v1/algoOrder` | Returns `strategyId` |
| Cancel algo order | `DELETE /fapi/v1/algoOrder` | By `strategyId` |
| Cancel all algo | `DELETE /fapi/v1/algoOpenOrders` | Symbol-level |
| Query open algo | `GET /fapi/v1/openAlgoOrders` | Returns `{ total, orders[] }` |

**Parameters used in this repo:**
- `workingType: MARK_PRICE` — trigger against mark price, not last price
- `timeInForce: GTE_GTC` — Good Till Expire / GTC; auto-cancels when position closes
- `closePosition: true` on TP2 and SL — closes full remaining position
- `reduceOnly: true` + explicit `quantity` on TP1 — partial 60% close

**In this repo:** `src/binance/rest-trade.ts` exports `placeAlgoOrder`, `cancelAlgoOrder`, `cancelAllAlgoOrders`, `getOpenAlgoOrders`. The `BinanceLiveExecutionAdapter` (`src/execution/binance-adapter.ts`) places TP1/TP2/SL exclusively via these endpoints.

### 4.3 Account and positions

| Endpoint | Purpose |
|----------|---------|
| `GET /fapi/v2/balance` | USDT wallet balance |
| `GET /fapi/v2/account` | Full account (assets + positions) |
| `GET /fapi/v2/positionRisk` | Open position details including `positionAmt`, `entryPrice`, `markPrice` |

Used for startup reconciliation: on boot, `getPositionRisk` detects any position that survived a restart, and the adapter restores internal state.

---

## 5. User Data Stream (private WebSocket)

### 5.1 Flow

1. `POST /fapi/v1/listenKey` (signed) → `listenKey`
2. Connect to `{wsBase}/private/ws?listenKey=<key>`
3. `PUT /fapi/v1/listenKey` every 30 min to keep alive
4. `DELETE /fapi/v1/listenKey` on shutdown

### 5.2 Events handled

| Event | Action |
|-------|--------|
| `ORDER_TRADE_UPDATE` | Logged; if `status=FILLED` + algo `si` field present → `notifyFilled()` reconciliation |
| `ACCOUNT_UPDATE` | Logged with position `pa` (amount), `ep` (entry price), `up` (unrealized PnL) |
| `MARGIN_CALL` | Logged |
| `listenKeyExpired` | Triggers listen key renewal and reconnect |

### 5.3 Algo strategyId correlation

When an algo TP/SL order fills, `ORDER_TRADE_UPDATE` includes field `si` (strategy ID) matching the `strategyId` returned when the algo order was placed. The orchestrator uses this to call `adapter.notifyFilled(si, avgPrice)` which:
- Looks up the internal trade via `algoIdToInternal` map
- For TP1 fill: updates `remainingQty`, leaves position open
- For TP2/SL fill: removes trade, cancels sibling orders, returns `ClosedPosition`
- Calls `positionManager.notifyExchangeClose()` — no redundant MARKET order

**In this repo:** `src/binance/private-ws.ts` (`BinancePrivateWs`). Enabled when `BINANCE_EXECUTION_ADAPTER=true` + `EXECUTION_MODE=live`.

---

## 6. Funding, mark, liquidation

- **Funding:** polled in paper mode via `GET /fapi/v1/premiumIndex`; charges open paper positions at each `nextFundingTime` crossing.
- **Mark vs last:** strategy uses mark price for TP/SL triggers (not last trade); `workingType: MARK_PRICE` on algo orders matches this.
- **Liquidation feed:** `@forceOrder` WS stream available when `BINANCE_USE_FORCE_ORDER=true` for SMC liquidity sweep detection.

---

## 7. WebSocket trading API (`ws-fapi`) — optional

For `session.logon` / `order.place` via WebSocket. Uses **Ed25519** signing only. Separate endpoint: `wss://ws-fapi.binance.com/ws-fapi/v1` (testnet: `wss://testnet.binancefuture.com/ws-fapi/v1`).

**In this repo:** `src/binance/futures-ws-api.ts` (`BinanceFuturesWsApiClient`) is available but is **not** the active execution path. The live adapter uses signed HMAC REST (`/fapi/v1/order`, `/fapi/v1/algoOrder`).

Quick test:
```bash
npm run fapi:ws:status
```

---

## 8. Precision and filters

`GET /fapi/v1/exchangeInfo` → `PRICE_FILTER.tickSize` + `LOT_SIZE.stepSize` + `LOT_SIZE.minQty`.

- All order **prices** are rounded to `tickSize` via `roundToTick(price, tickSize)`.
- All **quantities** are floored to `stepSize` via `floorToStep(qty, stepSize)`.

**In this repo:** `src/binance/rest-exchange-info.ts` + `src/mapping/precision.ts`. Precision is fetched at startup, pushed into the adapter via `setPrecision()`, and stored per-trade in `OpenLiveTrade`.

---

## 9. Rate limits, weights, errors

- REST: **request weight** per endpoint; `429` / `-1003` when exceeded.
- **IP bans** for sustained abuse.
- **Timestamp/recvWindow:** signed requests use `Date.now()` + 5s default window (`recvWindow=5000`).
- Binance error codes returned as `binanceCode` on `BinanceRestError` (e.g. `-4046` = margin type already set).

---

## 10. Implementation map

| Capability | Status | Location |
|------------|--------|----------|
| USD-M klines REST | ✅ | `src/binance/rest-klines.ts` |
| Exchange info / precision | ✅ | `src/binance/rest-exchange-info.ts` |
| Depth REST + local orderbook | ✅ | `rest-depth.ts`, `orderbook.ts` |
| Mark / premiumIndex REST | ✅ | `rest-premium-index.ts` |
| Market WS (multiplex) | ✅ | `ws-routing.ts`, `ws-multiplex.ts` |
| aggTrade tape | ✅ | `trade-tape.ts` |
| forceOrder liquidation feed | ✅ | `ws-multiplex.ts` (`BINANCE_USE_FORCE_ORDER`) |
| Signed HMAC REST client | ✅ | `src/binance/rest-client.ts` |
| Entry orders (`/fapi/v1/order`) | ✅ | `src/binance/rest-trade.ts` |
| Leverage + margin type setup | ✅ | `rest-trade.ts` → `BinanceLiveExecutionAdapter` |
| Algo TP/SL (`/fapi/v1/algoOrder`) | ✅ | `rest-trade.ts` → `BinanceLiveExecutionAdapter` |
| Position risk (`/fapi/v2/positionRisk`) | ✅ | `rest-trade.ts` (startup reconciliation) |
| Account / balances | ✅ | `rest-trade.ts` |
| Private user-data WebSocket | ✅ | `src/binance/private-ws.ts` |
| ORDER_TRADE_UPDATE reconciliation | ✅ | `orchestrator.ts` → `adapter.notifyFilled()` |
| Startup position reconciliation | ✅ | `orchestrator.ts` → `reconcileExchangePosition()` |
| WS-FAPI trading (`ws-fapi`) | Available (not primary) | `src/binance/futures-ws-api.ts` |

---

*Always verify endpoint parameters and URLs against live Binance documentation before production use.*
