# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Crypto algorithmic trading bot (`@coindcx/binance-hybrid`) implementing a Multi-timeframe Smart Money Concepts strategy for Binance USD-M Futures. Single-repo with three runtime components: trading bot, Vite dashboard UI, and an optional Redis-backed WebSocket gateway.

### Common commands

See `package.json` scripts and `README.md` for the full list. Key ones:

| Task | Command |
|------|---------|
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Test | `npm run test` |
| All checks | `npm run check` |
| Dev (hot-reload) | `npm run dev` |
| Single run | `npm run dev:once` |
| Dashboard + bot | `npm run dashboard:ui` |
| Vite UI only | `npm run ui:dev` |
| Build | `npm run build` |

### Environment setup

Copy `.env.example` to `.env` before running the bot. The defaults configure paper-trading mode (no API keys required). The `.env` file is gitignored.

### Gotchas

- **Binance REST 451 errors in cloud VMs:** Binance REST API (`fapi.binance.com`) returns HTTP 451 from certain cloud IP ranges (geo-restriction). This causes `candles_seed_failed` and `binance_exchange_info_failed` at startup. WebSocket streams (`fstream.binance.com`) still connect successfully, so the bot runs fine for paper trading — candle bars simply start empty and fill from live WS data.
- **Lint has pre-existing warnings/errors:** `npm run lint` exits non-zero due to 1 pre-existing error in `tests/p2-analytics.test.ts` (`prefer-as-const`) plus 4 warnings. These are in the existing codebase, not introduced by setup.
- **Vite CJS deprecation warning:** `npm run test` and `npm run ui:dev` emit a CJS deprecation notice from Vite. This is cosmetic and does not affect functionality.
- **Paper state files:** Running the bot creates `paper/` (wallet.json, trades.jsonl, equity.jsonl) and `logs/` (app.ndjson, trades.csv). These are gitignored.
