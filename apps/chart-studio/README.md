# Chart Studio

Multi-provider charting platform. TradingView-style UI over a normalized
market-data abstraction, with pluggable provider microservices (Binance,
DhanHQ, ...) talking over Redis pub/sub.

## Layout

```
apps/chart-studio/
├── packages/
│   ├── adapter-core/      shared TS lib: types, MarketDataProvider, RedisAdapter base, topic naming
│   ├── adapter-binance/   provider microservice (extracted from src/binance/*)
│   ├── adapter-dhanhq/    provider microservice (built against Dhan v2 spec)
│   └── gateway/           edge service: HTTP + WS, federates discovery, fans Redis ↔ browser
└── ui/                    Vite SPA: chart + panels + global search + provider settings
```

## Run

```
docker compose up --build
# UI on http://localhost:5174
# Gateway on http://localhost:4100
```

Or in dev:

```
npm install                       # at repo root, picks up workspace
npm run -w @chart-studio/adapter-core build
npm run -w @chart-studio/gateway dev
npm run -w @chart-studio/adapter-binance dev
npm run -w @chart-studio/adapter-dhanhq dev
npm run -w @chart-studio/ui dev
```

## Architecture

```
 ┌────────────┐   WS    ┌──────────┐   Redis pub/sub   ┌─────────────────┐
 │  Browser   │ <─────> │ gateway  │ <───────────────> │ adapter-binance │
 │  (Vite UI) │         │ (Node)   │                   ├─────────────────┤
 └────────────┘         └──────────┘ <───────────────> │ adapter-dhanhq  │
                                                       └─────────────────┘
```

- **One client WS connection**, multiplexed by `(provider, symbol, channel)`.
- **One Redis topic per (provider, symbol, channel)**; gateway ref-counts client subscriptions.
- **Federated discovery**: gateway fans `searchSymbols` across all online providers and merges.
- **URL format**: `#binance:BTCUSDT@1m`, `#dhanhq:NSE_EQ:RELIANCE@5m`.

## Adding a provider

1. New package `packages/adapter-<name>/`.
2. Implement `MarketDataProvider` from `@chart-studio/adapter-core`.
3. Extend `RedisAdapter` to auto-wire pub/sub topics.
4. Add a service to `docker-compose.yml`.

## Extracting to its own repo

Everything under `apps/chart-studio/` is self-contained — copy or
`git subtree split --prefix=apps/chart-studio` it to a new repo. The only
external coupling is `lightweight-charts`, `ws`, `ioredis`, `axios`, `zod`,
all available from npm.
