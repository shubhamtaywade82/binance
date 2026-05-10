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

## What you see while it runs

After seeding, the process stays open on the Binance WebSocket. Log lines (stdout):

| Event | Meaning |
|--------|--------|
| `runtime_help` | What to expect next (bar logs, signals, heartbeat). |
| `binance_ws_connected` | WS is up; streaming klines (+ mark on USDM). |
| `heartbeat` | Every `LOG_HEARTBEAT_SEC` seconds (default 60): last Binance mark, HTF/LTF EMA bias, aligned signal, bar counts. Set `LOG_HEARTBEAT_SEC=0` to disable. |
| `ltf_bar_closed` | Each **closed** LTF candle (e.g. every 15m): close, `htfBias` / `ltfBias`, `aligned` (would-trade direction if HTF/LTF agree). |
| `signal` / `paper_or_readonly_skip_order` | Only when the **aligned** signal **changes** from the previous value and is tradeable; paper mode logs intent instead of sending an order. |
| `binance_ws_reconnect` / `binance_ws_error` | Feed issues. |

So: if nothing changes for a long time, you should still see **`heartbeat`** once a minute and **`ltf_bar_closed`** every LTF interval.
