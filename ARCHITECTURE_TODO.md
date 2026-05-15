# Architecture TODO — Event-Sourced Trading Core

This file tracks the architectural pivot from orchestrator-centric runtime
to event-sourced trading core. Phase 1 has shipped in `architectural-updates`
(see "Landed" below). Phases 2–3 are scoped here.

---

## Landed (this session)

1. **Internal event bus** — `src/core/events/event-bus.ts`
   - Wildcard + typed subscribers, error-handler isolation, singleton `defaultEventBus`.
2. **Zod event contracts** — `packages/contracts/src/events.ts`
   - `DomainEvent<T>`, `KlineClosed`, `Trade`, `DepthDelta`, `BookTicker`, `Signal`,
     `OrderRequested`, `OrderValidated`, `OrderSubmitted`.
3. **MarketEventPublisher** — `src/market/distribution/event-publisher.ts`
   - Adapts `MultiplexCallbacks` → events. Merged via `mergeMultiplexCallbacks`
     so dashboard sidecar and event bus both see the feed.
4. **Append-only EventStore** — `pg-writer.appendEvent` + `events` table
   (`pnl-dashboard/db/migrations/005_events_table.sql`, mirrored into `schema.sql`).
5. **SymbolActor** — `src/core/actors/symbol-actor.ts`
   - Owns per-symbol `MultiTimeframeStore` + `LocalOrderBook` + `AggTradeTape`.
   - Strategies receive a proper `StrategyContext` with `getHistory(tf?)`.
6. **ActorSystem** — auto-attaches `SmcStrategyModule` (default) or
   `SolMtfStrategyModule` (SOL\*) on `spawnSymbolActor`.
7. **StrategyModule plugin interface** — `src/core/strategy/strategy-module.ts`
   - `onKline` mandatory; `onTrade` / `onBookUpdate` optional.
   - Adapted strategies: `smc-module.ts`, `sol-mtf-strategy-module.ts`.
8. **RiskEngine** — centralised gate.
   - Invariants: `MAX_TOTAL_EXPOSURE_USDT`, `MAX_OPEN_SYMBOLS`,
     `MAX_OPEN_POSITIONS`, `MAX_NOTIONAL_USDT`, opposite-side guard.
   - Real exposure tracking via `execution.order.filled` /
     `execution.position.closed`.
9. **SignalToOrderBridge** — converts `strategy.signal` → `execution.order.requested`,
   applies sizing (`CAPITAL_PER_TRADE_USDT` × `LEVERAGE`), attaches TP/SL,
   enforces per-symbol cooldown.
10. **ExecutionBridge** — subscribes `execution.order.accepted`, calls the
    configured `ExecutionAdapter` (paper / Binance / CoinDCX), emits
    `.submitted` / `.filled` / `.rejected`.
11. **MarketClock** — `src/core/time/market-clock.ts`. Single `now()` for the
    core. `LIVE` reads `Date.now()`; `REPLAY` reads the event being dispatched.
12. **ReplayEngine** — `src/replay/replay-engine.ts` + `scripts/replay.ts`.
    Wires actors + risk + execution to historical events; `--speed=max` for
    fast-forward, decimal multipliers for wall-clock playback.
13. **Worker isolation primitive** — `src/core/runtime/{script-worker,worker-manager}.ts`.
    Foundation for NanoPine sandboxing (hardening in Phase 2).
14. **Opt-in cutover flag** — `EVENT_BUS_EXECUTION_ENABLED` (default `false`).
    Lets the event-bus path run shadow alongside the legacy orchestrator until
    parity is verified.

---

## Phase 2 — Hardening (next 1–2 weeks)

### Strategy plugin loader
- Replace hardcoded `SmcStrategyModule` / `SolMtfStrategyModule` attachment in
  `ActorSystem.attachDefaultStrategies` with a registry driven by config.
- Config: `STRATEGIES_PER_SYMBOL=BTCUSDT:smc,smc-confluence;SOLUSDT:sol-mtf`.
- Directory layout: `src/strategies/<id>/index.ts` exporting
  `{ id, factory: (ctx: StrategyContext) => StrategyModule }`.

### NanoPine worker hardening
Current `script-worker.ts` uses `new Function(...)` — escape via `__proto__`
or `constructor` chain still possible. Needed:
- Switch to `node:vm` `Script.runInContext` with frozen context, OR
- Switch to `isolated-vm` (full V8 isolate).
- Per-script:
  - heap cap (`isolated-vm` supports `memoryLimit`).
  - execution timeout via worker-thread kill + token cancellation.
  - quota counters (already partially in `indicator-runtime` ExecutionContext).

### Gateway split
`src/dashboard/bridge.ts` is overloaded. Split into:
- `gateway/market-stream-gateway.ts` — WS broadcast of market events.
- `gateway/dashboard-api.ts` — REST/WS for positions, equity, scripts.
- `gateway/scripts-api.ts` — `/api/scripts*` CRUD + AI generation.
Each owns its own port (or path under one HTTP server). Bridge can become a thin
composition root.

### Position state machine (OMS)
Orders today are fire-and-forget at adapter call. Need:
```
NEW → SUBMITTED → ACK → PARTIAL → FILLED
                   ↓
                CANCEL_PENDING → CANCELLED
                   ↓
                REJECTED / EXPIRED
```
- File: `src/core/execution/order-state-machine.ts`.
- Track every transition on the event bus.
- Reconcile against Binance user-data WS (`ORDER_TRADE_UPDATE`).

### Behavioral risk
RiskEngine currently enforces portfolio caps only. Add:
- **Drawdown lock**: stop opening on `realized_pnl_24h < -X`.
- **Loss streak lock**: N consecutive losing trades → cool-off Tms.
- **Overtrading guard**: max N orders / hour / symbol.
- **Liquidation proximity**: reject if `markPrice` within `K * ATR` of liq price.
- **ADL risk**: reject when Binance ADL indicator > threshold.
- **Funding spike**: reject open when |funding rate| > X bps.
Wire as additional subscribers on `execution.order.requested`; any of them may
emit `.rejected`.

### Stale feed / desync invariants
- `system.stale` event when no kline closed in `tf × 2`.
- `system.desync` when orderbook resync triggered.
- RiskEngine rejects new orders on `system.stale` until cleared.

### Tests
- Vitest suite per bridge: `signal-to-order-bridge.test.ts`,
  `execution-bridge.test.ts`, `risk-engine.test.ts`, `symbol-actor.test.ts`.
- Replay-determinism golden test: replay a fixture event log twice, assert byte-equal
  outbound event sequence.

---

## Phase 3 — Scale-out (next 1–3 months)

### Move event bus off-process
In-process `EventEmitter`-style bus works for one node. For horizontal scale:
- Replace `defaultEventBus` with **NATS JetStream** (preferred — lightweight, exactly-
  once via consumers) or **Kafka** (heavier, more ops).
- Each subsystem becomes a consumer group.
- EventStore becomes optional (NATS streams are already durable).

### Symbol sharding across nodes
- Hash `symbol` → node id; spawn `SymbolActor` only on that node.
- Strategy / risk / execution colocated with their actor.
- Cross-symbol risk (correlation cap, total exposure) needs a single
  `PortfolioRisk` actor — pick a leader via Redis lock.

### Exchange SDK split
Move per-exchange code into `packages/exchanges/<name>/{market-data,execution,account,precision,websocket}/`.
Today `binance-adapter.ts` covers only execution; market-data + account live
under `src/binance/*` mixed with hot-path code.

### Research vs execution monorepo split
```
apps/
  trader-runtime/   ← current src/
  research-lab/     ← Jupyter-style backtests against replay-engine
  pnl-dashboard/    ← already separated
  ai-assistant/     ← market-brief.ts + mcp-bridge.ts
  ml-engine/        ← ml_bot/

packages/
  market-core/      ← types, normalization, stores
  execution-core/   ← OMS, adapters, contracts
  strategy-sdk/     ← StrategyModule + helpers
  indicator-runtime/← already a package
  replay-engine/
  risk-engine/
  contracts/        ← already a package
```

### GPU ML inference
`inference-client.ts` currently calls a Python HTTP server. For sub-50ms gates,
move to:
- ONNX Runtime (Node binding) — load model in-process; or
- Triton Inference Server with HTTP/gRPC + dynamic batching.

---

## Known leaks / hidden coupling to fix opportunistically

- `src/orchestrator.ts` still owns multi-TF state + strategy dispatch; the
  `actorSystem` runs in parallel. Cut this over fully under `EVENT_BUS_EXECUTION_ENABLED=true`.
- `EventStore.startRecording` is called once and never stopped; lifecycle
  needs a `dispose()`.
- `MarketEventPublisher` writes `quoteVolume`/`trades` as `0` when the candle
  lacks them — must source from raw WS kline payload, not `Candle` type.
- `SymbolActor.handleDepth` mutates `LocalOrderBook` but doesn't broadcast a
  derived `market.depth.book` event for downstream consumers.
- Strategies that need order-book imbalance (e.g. SMC confluence) can't
  reach it through `StrategyContext` — extend ctx with `getBook()` + `getTape()`.
- `paperAdapter.placeOrder` doesn't emit any event itself; `ExecutionBridge`
  synthesises events from the return value. When the adapter triggers internal
  TP/SL closes, those must be lifted into `execution.position.closed`.

---

## Operational TODOs

- Provision `events` table in production Postgres (`migrate.sh` already
  picks up `005_events_table.sql`).
- Add Prometheus counters: `events_published_total{type}`,
  `risk_rejections_total{reason}`, `bridge_orders_submitted_total{adapter}`.
- Grafana panel: live event throughput; risk reject reasons; replay vs live
  outcome diff (for determinism alerts).
- Document `EVENT_BUS_EXECUTION_ENABLED` cutover procedure in `README.md`.
