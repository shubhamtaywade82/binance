# SOL 1.5% Capture Strategy (SMC Confluence)

This document codifies a multi-timeframe Smart Money Concepts (SMC) strategy for capturing ~1.5% directional SOL moves.

## 1) Timeframe pipeline

- **Daily (bias):** market structure trend and directional bias.
- **4H (structure):** BOS/CHoCH confirmation, EMA trend, premium/discount guard.
- **1H (setup):** order-block context, recent liquidity sweep, Gate A quality.
- **15M + 5M (execution):** local trigger and momentum confirmation.

## 2) Entry filters

### Long

All of the following:

1. Daily trend/bias aligned bullish.
2. 4H bullish structure and EMA alignment.
3. 1H setup score >= 2/3:
   - active OB,
   - recent downside liquidity sweep,
   - Gate A pass.
4. 15M entry score >= 3/4:
   - active OB,
   - recent downside liquidity sweep,
   - Gate C pass,
   - bullish CHoCH or BOS.
5. 5M trigger active + bullish CHoCH.
6. Not extended into risky HTF resistance zone.
7. A plausible liquidity objective exists at +1.5%.

### Short

Mirror of long logic with bearish equivalents.

## 3) Confluence score

Weighted components:

- 4H bias (2.0)
- EMA + structure confirmation (1.5)
- Premium/discount timing (1.0)
- Gate A (1.0)
- OB zone (1.0)
- Liquidity sweep (1.5)
- Gate C (0.5)
- CHoCH confirmation (1.0)

Suggested thresholds:

- **Sniper mode:** >= 4.0
- **Standard mode:** >= 3.0

## 4) Trade management

- Use fixed-risk sizing (`risk_amount / stop_distance`).
- Skip setups with insufficient reward-to-risk for a +1.5% objective.
- Scale out:
  - TP1 around +0.9% (de-risk),
  - TP2 at +1.5%.
- Optional trail after TP1 activation.

## 5) Session filtering

Prefer high-liquidity windows, especially NY AM. De-prioritize low-volatility windows unless confluence is extreme.

## 6) Portfolio risk controls

- Daily loss cap by account tier.
- Max concurrent positions.
- Per-trade risk ceiling.
- Correlation guard (e.g., avoid SOL direction that conflicts with strong BTC regime exposure).

## 7) Integration notes for this repo

To implement in runtime:

1. Extend `src/strategy/smc.ts` with explicit multi-timeframe confluence state.
2. Introduce a scoring module (weights + threshold modes).
3. Add session gating and correlation filter hooks in orchestrator flow.
4. Add TP ladder support in `PositionManager` while preserving existing risk checks.
5. Add backtest fixtures for 5m execution with HTF context snapshots.

## 8) Rollout

- Phase 1: paper trade validation.
- Phase 2: micro-size live shadow deployment.
- Phase 3: full-size only after live metrics are within tolerance vs. paper/backtest.
