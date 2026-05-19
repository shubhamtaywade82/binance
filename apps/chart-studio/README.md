# Chart Studio

Multi-provider charting platform. TradingView-style UI over a normalized
market-data abstraction, with pluggable provider microservices (Binance,
DhanHQ, ...) talking over Redis pub/sub.

## Features

- **Multi-provider**: federated symbol search across all online adapters;
  switch between Binance USDT-M futures and Dhan NSE/BSE/MCX from the same UI.
- **Watchlist**: starred symbols persist in localStorage; live LTPs.
- **Indicators**: built-in EMA / RSI / MACD / Bollinger / VWAP, plus
  separate panes for oscillators. Configure params per-instance.
- **NanoPine scripts**: bar-by-bar indicator/strategy runtime, executed
  in a Web Worker. Plots render directly on the chart.
- **Alerts**: client-side price / crossover alerts with browser notifications.
- **Drawing tools**: horizontal lines, trend lines (persisted per symbol).
- **Order book + trade tape + sentiment**: live, normalized panels.
- **Rotated Dhan tokens**: pull live access tokens from a local
  `algo_scalper_api` instead of pasting static creds.

## Layout

```
apps/chart-studio/
├── packages/
│   ├── adapter-core/       shared TS lib: types, MarketDataProvider, RedisAdapter base, topics
│   ├── indicator-runtime/  vendored NanoPine lexer/parser/interpreter + TA primitives
│   ├── adapter-binance/    provider microservice (Binance USDT-M / spot)
│   ├── adapter-dhanhq/     provider microservice (Dhan v2 — REST + binary WS)
│   └── gateway/            edge service: HTTP + WS, federates discovery, fans Redis ↔ browser
└── ui/                     Vite SPA — chart, panels, search, scripts, alerts, drawings
```

## Run

Copy `.env.example` to `.env` and fill in Dhan credentials (or point at
`algo_scalper_api`):

```bash
docker compose up --build
# UI:      http://localhost:5174
# Gateway: http://localhost:4100
```

Local dev (no docker):

```bash
npm install
npm run -w @chart-studio/adapter-core build
npm run -w @chart-studio/indicator-runtime build

# Each in its own terminal:
npm run -w @chart-studio/gateway dev
npm run -w @chart-studio/adapter-binance dev
npm run -w @chart-studio/adapter-dhanhq dev
npm run -w @chart-studio/ui dev
```

## Dhan auth — algo_scalper_api

The Dhan WebSocket needs a fresh `access_token` every ~24h. If you set
`ALGO_SCALPER_URL`, the adapter polls that endpoint for rotated creds
instead of using `DHAN_CLIENT_ID` / `DHAN_ACCESS_TOKEN`:

```
GET ${ALGO_SCALPER_URL}
  -> 200 { "client_id": "1000...", "access_token": "eyJ...", "expires_at": 1735689600 }
```

`expires_at` may be unix seconds or ms. The adapter refreshes:
- on first request,
- proactively ~60s before `expires_at`,
- on any 401 from a REST call,
- on auth-failure WS close codes (1008 / 4001 / 4003).

From inside docker the adapter resolves `host.docker.internal` to the
host machine, so a local `algo_scalper_api` works out of the box:

```
ALGO_SCALPER_URL=http://host.docker.internal:8080/token
```

## URLs

- `#binance-usdm:BTCUSDT@1m`
- `#dhanhq:NSE_EQ:1333@5`
- `#dhanhq:NSE_FNO:<security_id>@15`

The Dhan adapter uses `<EXCHANGE_SEGMENT>:<SECURITY_ID>` as the canonical
symbol; the UI's global search resolves human names (e.g. RELIANCE) to that.

## Wire protocol

- gateway → adapter: `chart.ctrl.<provider>` (sub/unsub), `chart.discover.<provider>.req`
- adapter → gateway: `chart.data.<provider>.<symbol>.<channel>[.<key>]`,
  `chart.presence.<provider>`, `chart.discover.<provider>.rep.<reqId>`

## Adding a provider

1. New package `packages/adapter-<name>/`.
2. Implement `MarketDataProvider` from `@chart-studio/adapter-core`.
3. Wrap it in `RedisAdapter` to auto-wire pub/sub.
4. Add a service to `docker-compose.yml`.

## Extracting to its own repo

Everything under `apps/chart-studio/` is self-contained. To split:

```
git subtree split --prefix=apps/chart-studio -b chart-studio
git push <new-remote> chart-studio:main
```

Or just `cp -r` it. No imports back into the bot — the only shared
artifacts are vendored copies of `packages/indicator-runtime` and
relevant pieces of `src/binance/*` (already refactored into
`packages/adapter-binance`).
