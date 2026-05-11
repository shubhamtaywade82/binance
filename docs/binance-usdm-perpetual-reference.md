# Binance USDⓈ-M perpetual futures — API reference (for this workspace)

Scope: **USDⓈ-M (USDT-margined) perpetual contracts** on Binance Derivatives — market data, WebSockets, trading, account, funding, and algo.  
Not covered in depth here: **COIN-M** (`dapi`), **Options**, **Portfolio Margin** (`papi`) unless noted as “different product”.

Official hubs:

- [Derivatives documentation](https://developers.binance.com/docs/derivatives) — USDⓈ-M Futures is the primary doc tree for `/fapi` + `fstream`.
- [Algo documentation](https://developers.binance.com/docs/algo) — TWAP / VP and related **signed** `/sapi/v1/algo/...` endpoints (execution style, not a separate market feed).

---

## 1. Environments and base URLs

| Layer | Mainnet | Testnet (demo) |
|--------|---------|----------------|
| **REST (USD-M)** | `https://fapi.binance.com` | `https://demo-fapi.binance.com` |
| **WebSocket (USD-M)** | Root `wss://fstream.binance.com` | `wss://fstream.binancefuture.com` |

Binance has documented **routed** WebSocket paths under that root (see *Important WebSocket Change Notice* in [USD-M WebSocket market streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams)): in practice you connect to **`{root}/market/stream`** or **`{root}/public/stream`** (combined) or **`{root}/market/ws/...`** / **`{root}/public/ws/...`** (raw), not always a single legacy `…/ws/<stream>` on the bare host.

**This repo** (`src/binance/ws-routing.ts`): normalizes `BINANCE_WS_BASE` to a **root** and builds:

- **`/market/...`** — e.g. kline, aggTrade, mark price (see `routeForStream`).
- **`/public/...`** — e.g. `@bookTicker`, `@depth` (see `routeForStream`).

Spot (if you use `BINANCE_PRODUCT=spot`) uses **`wss://stream.binance.com:9443`** — different product from USD-M perp.

---

## 2. Market data — REST (`/fapi`)

Typical categories (exact paths and weights: official **Market Data REST API** doc):

| Use | Examples | Notes |
|-----|-----------|--------|
| **Candles** | `GET /fapi/v1/klines` | `symbol`, `interval`, `limit`, optional `startTime`/`endTime` |
| **Order book** | `GET /fapi/v1/depth` | Snapshot; maintain locally with WS `depth` if needed |
| **Trades** | `GET /fapi/v1/trades`, `GET /fapi/v1/aggTrades` | Public recent trades |
| **Ticker / 24h** | `GET /fapi/v1/ticker/24hr`, `GET /fapi/v1/ticker/price` | Last / stats |
| **Mark / funding** | `GET /fapi/v1/premiumIndex`, `GET /fapi/v1/fundingRate` | Mark, index, funding for perps |
| **Exchange info** | `GET /fapi/v1/exchangeInfo` | Filters, tick/step, contract specs |

All of the above are **unsigned** for public endpoints (no API key on request).

**This repo** uses a subset: e.g. `rest-klines`, `rest-premium-index`, `rest-depth`, historical helpers — not full exchange coverage.

---

## 3. Market data — WebSocket (USD-M)

### 3.1 Stream names (lowercase symbol)

Examples (see official **Websocket Market Streams**):

- `<symbol>@aggTrade` — aggregate trades (LTP-style tape).
- `<symbol>@markPrice` or `<symbol>@markPrice@1s` — mark price.
- `<symbol>@kline_<interval>` — candle updates (`k.x` = closed bar).
- `<symbol>@depth` / `<symbol>@depth@100ms` — diff depth.
- `<symbol>@bookTicker` — best bid/ask.
- `<symbol>@forceOrder` — liquidations (single symbol); `!forceOrder@arr` — all markets.

### 3.2 Combined vs raw

- **Combined:** `{root}/{route}/stream?streams=a@aggTrade/b@kline_1m` — payload wrapped `{ "stream": "...", "data": { ... } }`.
- **Raw:** `{root}/{route}/ws/btcusdt@aggTrade` — payload is the event object directly.

### 3.3 Operational rules (from Binance general WSS guidance)

- **Ping / pong:** server may send WebSocket **ping** frames; client must **pong** with the same payload within the documented window or risk disconnect.
- **`serverShutdown`:** JSON event before maintenance; reconnect promptly.
- **Limits:** e.g. max streams per connection, max connections per IP per interval, max **incoming** messages per second (control messages count) — see official **WebSocket Limits** for your product.

### 3.4 Network reality (this repo)

Some networks allow **`fapi` HTTPS** but not **`fstream` pushed frames** (socket **opens**, no `kline`/`aggTrade`/`markPrice`). Mitigations used here:

- **`USDM_MARK_REST_POLL_SEC`** — poll `GET /fapi/v1/premiumIndex` for mark.
- Optional **spot** WS/REST for signals if you switch product — **not** identical to perp tape.

---

## 4. Trading — REST (signed, `/fapi`)

Requires **API key** + **HMAC SHA256** signing (or Ed25519 where supported — follow official **Authentication** doc for USD-M).

Typical areas:

| Area | Examples | Purpose |
|------|-----------|--------|
| **Orders** | `POST /fapi/v1/order`, `DELETE /fapi/v1/order`, `GET /fapi/v1/openOrders` | Place, cancel, query |
| **Batch** | `POST /fapi/v1/batchOrders` | Multiple orders |
| **Position mode** | `GET/POST …/positionSide/dual` | Hedge vs one-way |
| **Leverage / margin type** | `POST …/leverage`, `POST …/marginType` | Setup |

Order types include **LIMIT**, **MARKET**, **STOP** / **TAKE_PROFIT** variants, **reduceOnly**, **closePosition**, etc. — exact enums in official **Trade REST** doc.

**This repo** does **not** place orders on Binance; execution is **CoinDCX** (`src/coindcx/futures-client.ts`). Adding Binance execution would be a **new** signed client + keys + compliance review.

---

## 5. Account & positions — REST (signed, `/fapi`)

| Area | Examples |
|------|-----------|
| **Balances** | `GET /fapi/v2/balance` (or v3 per current doc) |
| **Account** | `GET /fapi/v2/account` — positions, assets, margin |
| **Position risk** | `GET /fapi/v2/positionRisk` |
| **Income / funding history** | `GET /fapi/v1/income` |

Use official **Account** endpoints list; field names and versions change — always match the doc version you target.

---

## 6. User Data Stream (private WebSocket)

Flow (conceptual):

1. **`POST /fapi/v1/listenKey`** (signed) → `listenKey`.
2. Connect to **user data** WS URL for USD-M (see official **User Data Streams** for exact base path).
3. **`PUT /fapi/v1/listenKey`** periodically to keep the key alive.
4. **`DELETE /fapi/v1/listenKey`** when shutting down.

Events typically include order updates, execution reports, account/position updates — exact event types in official doc.

**This repo:** no Binance user stream (no Binance keys for trading).

---

## 7. Funding, mark, liquidation (perp-specific)

- **Funding:** scheduled funding rate payments; query history via REST; some WS streams expose funding-related fields on mark streams.
- **Mark vs last:** mark is used for PnL / liquidations on many perps; **last** trade price can differ.
- **Liquidations:** REST `forceOrders` (history limits per changelog); WS `@forceOrder` / `!forceOrder@arr` for live liquidation feed.

---

## 8. Algo orders (Binance) — `/sapi/v1/algo/...`

[Algo Trading](https://developers.binance.com/docs/algo) covers **algorithmic** order products served from **SAPI** (e.g. `/sapi/v1/algo/futures/...` for futures TWAP / VP, `/sapi/v1/algo/spot/...` for spot TWAP).

Important:

- **Separate signing base** from `/fapi` — typically **`https://api.binance.com`** for SAPI (confirm in official Quick Start for your account type).
- Algo is for **how** Binance slices your order over time / volume; it is **not** a replacement for market-data WS.
- Changelogs mention **percent-encoding before signature** for some signed flows — follow the latest **Signed Endpoints** examples or you risk `-1022 INVALID_SIGNATURE`.

**This repo:** no Binance algo integration.

---

## 9. Rate limits, weights, errors

- REST: **request weight** per endpoint; **429** / `-1003` style errors when exceeded — see **Limits** in general info.
- **IP bans** for abuse (including WS control-message floods).
- **Timestamp / recvWindow:** signed requests must use server time skew rules from the doc.

---

## 10. How this maps to the `coindcx/binance` worker

| Binance capability | In this repo? | Location / notes |
|--------------------|---------------|-------------------|
| USD-M klines REST | Yes | `src/binance/rest-klines.ts` |
| Depth REST / local book | Partial | `rest-depth`, orderbook + WS depth |
| Mark / premium REST | Yes | `rest-premium-index.ts`, orchestrator poll |
| Market WS (routed market/public) | Yes | `ws-routing.ts`, multiplex / streams |
| aggTrade tape | Partial | `trade-tape.ts` etc. |
| **Signed `/fapi` orders** | **No** | Would need new module + keys |
| **User data stream** | **No** | Would need listenKey lifecycle |
| **Balances / positions on Binance** | **No** | CoinDCX holds execution state here |
| **Algo (TWAP/VP) on Binance** | **No** | Separate SAPI client |

**Architecture invariant (workspace):** crypto **execution** for this hybrid design is **CoinDCX futures**, not Binance. Binance here is **signal / reference market data** unless you explicitly extend the codebase.

---

## 11. Suggested reading order (on Binance’s site)

1. [USDⓈ-M Futures — General Info](https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info) — REST base, enums, errors, limits.  
2. [Market Data REST](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api) — everything public REST for bars and tape.  
3. [Websocket Market Streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams) — routes, stream list, combined/raw.  
4. [Trade REST](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api) — only if you add Binance execution.  
5. [User Data Streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/user-data-streams) — only with listenKey + private WS.  
6. [Algo](https://developers.binance.com/docs/algo) — only if you route TWAP/VP through Binance.

---

*This file is a curated map for developers in this repo; always verify parameters and URLs against the live Binance documentation before production use.*
