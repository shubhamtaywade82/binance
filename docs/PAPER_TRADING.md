# Paper Trading on Binance USD-M (Mainnet Data, Simulated Fills)

Profile: `.env.paper.example`

This profile streams live Binance USD-M Futures **mainnet** market data through the
full SMC / MTF / ML pipeline but simulates every fill locally via the paper engine
(`src/execution/paper/`). No live order ever reaches an exchange.

## Symbol tiers

| Tier | Symbols                         | Notes                                          |
|------|---------------------------------|------------------------------------------------|
| 1    | `BTCUSDT`, `ETHUSDT`, `SOLUSDT` | Deep liquidity, tight spreads, best for MTF.   |
| 2    | `SUIUSDT`, `AVAXUSDT`, `LINKUSDT` | Higher beta; size down, expect more slippage. |

`BINANCE_SYMBOL` (default `SOLUSDT`) is the **execution primary**. The rest of the
watchlist streams to the dashboard / feature pipeline but is not auto-traded
unless the strategy is widened.

## Recommended leverage (paper)

| Symbol   | Suggested `LEVERAGE` | Notes                                  |
|----------|----------------------|----------------------------------------|
| BTCUSDT  | 3 – 5                | Low realised vol, room for wide stops. |
| ETHUSDT  | 3 – 5                |                                        |
| SOLUSDT  | 5 – 8                | Default profile uses `5`.              |
| SUIUSDT  | 3 – 5                | Thinner book — keep size modest.       |
| AVAXUSDT | 3 – 5                |                                        |
| LINKUSDT | 3 – 5                |                                        |

## Best IST trading windows

- **15:30 – 19:30 IST** — EU session open + US pre-market, strong directional flow.
- **19:30 – 02:00 IST** — US session, peak liquidity for BTC/ETH/SOL.
- Avoid **05:00 – 11:00 IST** (Asia mid-session) — frequent chop on alts.

## Start paper trading

```bash
cp .env.paper.example .env

# One-shot (docker postgres + bot + dashboard UI):
npm run stack:up

# Or run components individually:
npm run dashboard      # bot + dashboard WS on :4001, Prometheus on :9090
npm run pnl:ui         # Next.js PnL dashboard (separate terminal)
```

## Verification checklist

Before walking away from a paper run, confirm:

- [ ] Heartbeat status line shows the INR/USDT strip:
      `EQ: ₹… (… USDT) │ WAL: … │ UR: … │ NET: … │ UNREAL USDT: … │ DD: …% │ RISK: SAFE`
- [ ] `paper/wallet.json` updates on each fill; `paper/equity.jsonl` is appending.
- [ ] PnL dashboard at `http://localhost:3000` shows the `EQ / WAL / UR / NET /
      UNREAL USDT / DD / RISK` strip and the `1 USDT = ₹…` badge with a live source.
- [ ] Logs show `orchestrator_started executionMode=paper executionAdapter=coindcx`.
- [ ] No `binance_private_ws_connected` line — private user-data WS must stay off.
- [ ] `BINANCE_API_KEY` / `BINANCE_API_SECRET` / `COINDCX_API_KEY` / `COINDCX_API_SECRET`
      are empty in the loaded `.env`.
- [ ] `CONFIRMED_LIVE_TRADING=false` and `BINANCE_EXECUTION_ADAPTER=false`.
- [ ] FX badge source = `snapshot` (live) within a minute, not `fallback`.

## Resetting paper state

```bash
node -e "const fs=require('fs');const t=Date.now();
  fs.writeFileSync('paper/wallet.json', JSON.stringify({
    balanceUsdt:10000,availableUsdt:10000,usedMarginUsdt:0,
    unrealizedPnlUsdt:0,realizedPnlUsdt:0,equityUsdt:10000,updatedAt:t
  },null,2));
  fs.writeFileSync('paper/equity.jsonl','');"
```

## Going live (later)

Going from paper → live is **not** a flag flip:

1. Switch to testnet first (`BINANCE_FUTURES_TESTNET=true`,
   `BINANCE_EXECUTION_ADAPTER=true`, `EXECUTION_MODE=live`, testnet keys set).
2. After a clean testnet week, flip mainnet (`BINANCE_FUTURES_TESTNET=false`,
   real keys, `CONFIRMED_LIVE_TRADING=true`, `MAX_NOTIONAL_USDT=50` for the first
   week per `TODO.md`).
