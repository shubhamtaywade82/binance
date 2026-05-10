# Binance data + CoinDCX execution

Standalone TypeScript worker: **Binance** public REST/WebSocket for signals, **CoinDCX** signed REST for futures orders (parity with `coindcx-bot` [`CoinDCXApi`](../coindcx-bot/src/gateways/coindcx-api.ts) — see [`src/coindcx/futures-client.ts`](src/coindcx/futures-client.ts)).

## Binance

- REST: USD-M futures klines (`/fapi/v1/klines`) or spot (`/api/v3/klines`) via `BINANCE_PRODUCT`.
- WebSocket: combined stream on `fstream.binance.com` (USDM) per [Binance Developers](https://developers.binance.com/docs).

## CoinDCX

- Environment variables match `coindcx-bot` (`API_BASE_URL`, `COINDCX_API_KEY`, `COINDCX_API_SECRET`, …).
- Default: `READ_ONLY=true`, `EXECUTION_ENABLED=false` — logs only.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev
```

```bash
npm run check
```

## Symbol map

`BINANCE_SYMBOL` (e.g. `SOLUSDT`) must align with `COINDCX_PAIR` (e.g. `B-SOL_USDT`). Adjust both in `.env`.
