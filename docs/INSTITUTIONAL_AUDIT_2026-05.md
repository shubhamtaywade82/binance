# Institutional Trading Systems Audit — `shubhamtaywade82/binance`

> **Date:** 2026-05-17
> **Branch reviewed:** `claude/audit-trading-platform-D9MG7` (off `main` @ `cd8d39d`)
> **Reviewer capacity:** Principal Trading Systems Architect · HFT Infrastructure Reviewer · Distributed Systems Auditor · Production Reliability Engineer
> **Scope:** Full architectural, execution, market-data, risk, observability, and disaster-recovery review of the hybrid Binance‑data / CoinDCX‑execution leveraged-futures bot.
> **Method:** End-to-end source trace of ~140 files across `src/binance`, `src/coindcx`, `src/execution`, `src/core`, `src/strategy`, `src/risk`, `src/ai`, `src/persistence`, `src/services`, `src/observability`, `src/replay`, `tests`, plus Dockerfile / compose / `TODO.md` / `ARCHITECTURE_TODO.md`.

---

## 1. Executive Summary

The codebase is **above-average for a one‑author trading bot** — Zod‑typed config, an internal event bus, an actor‑per‑symbol model, a RiskEngine that gates orders, a serious paper engine (slippage / funding / liquidation / wallet persistence), startup reconciliation against `positionRisk` + `openAlgoOrders`, deterministic replay infrastructure, Prometheus and Telegram, and a real Binance Algo Service integration for TP/SL.

However, judged **as an institutional leveraged‑futures execution system**, it has **systemic, intersecting flaws** that any one of the following can convert into a six‑figure loss event:

1. **Two parallel execution stacks running simultaneously** — the legacy `HybridOrchestrator` (which still owns 1,943 lines of multi-TF state, strategy dispatch, position management, ML, AI, mark-price polling, exit logic) and the new event-bus stack (`ActorSystem → SymbolActor → SignalToOrderBridge → RiskEngine → ExecutionBridge → adapter`). `EVENT_BUS_EXECUTION_ENABLED` is a kill switch, not a real cutover; the commit log literally contains `fix(critical): REVERSAL death spiral — disable legacy eval path under event-bus`. Two strategy dispatch paths over the same EventBus mean every guarantee (dedup, cooldown, opposite-side, allocator) is bypassable via the other path.
2. **In-process synchronous EventBus is the entire backbone** — no backpressure, no DLQ, no replay-on-failure, no isolation; a slow Postgres or Telegram subscriber back-pressures kline processing, and a thrown async error in any subscriber disappears into `console.error`.
3. **Hybrid-exchange architecture is fundamentally unsound for live trading.** Binance market data drives CoinDCX execution, but CoinDCX is a separate orderbook with its own mark price, fees, slippage, lot size, and funding schedule. The paper engine is calibrated to Binance bookTicker; the live CoinDCX adapter has *zero* idempotency, no client_order_id, no order state machine, no rate-limit retry, no startup reconciliation, and uses `exitFuturesPosition` → REST polling for an exit price. Strategy edge measured in paper-on-Binance is a **categorical mismatch** to fills realized on CoinDCX.
4. **Order idempotency is missing on the path that actually places orders.** CoinDCX `createFuturesOrder` is called with no client-order-id; the REST retry wrapper retries 5xx/408/429 on POST; `executeWithRetry` does not distinguish idempotent from non-idempotent calls. A single TCP RST between the order placing and the response = duplicate fill, larger position than the bot believes, mis-sized SL.
5. **State is fragmented across at least four sources of truth** — adapter in-memory map, `PositionManager` map (legacy), `RiskEngine.positions` map (event-bus), `wallet.json`, Redis, Postgres, and the exchange. On live, `RiskEngine.seedPositions()` is only wired for `execution.paperAdapter`; live boots with zero positions and accepts opposite-side orders against a real exchange position.
6. **Critical safety systems are advisory, not enforcing.** `StaleGuard` logs staleness but is not consulted by `ExecutionBridge`. `StreamAligner` is not called pre-signal. ML gate fails *open* when Ollama is unreachable. `DAILY_DRAWDOWN_KILL_PCT` defaults to 0. `MAX_NOTIONAL_USDT` defaults to 0 (disabled). `CorrelationGuard` is initialized once from env JSON and never updates. The Control HTTP server has no authentication and can flatten positions over `curl`.
7. **Repaint/lookahead bias is structurally possible.** `analyzeSmc` checks `candles[i+1]` for FVG fill; `MultiTimeframeStore.insertCandle` overwrites a sealed bar on `openTime` match irrespective of `isFinal`; HTF EMA bias reads `closes[i]` (current, possibly in-progress).

This is a **paper-trading research engine with live-trading aspirations attached**. It is not production-ready for unattended leveraged futures.

---

## 2. Scorecard

| Dimension | Score / 10 | Rationale |
|---|---|---|
| **Architecture Risk Score** *(higher = riskier)* | **8.0** | Two parallel execution stacks, god-orchestrator, in-process bus, shared mutable maps |
| **Trading Reliability Score** | **3.5** | No OMS state machine, no idempotency on CoinDCX live, fire-and-forget orders, async cancel racing fills |
| **Production Readiness Score** | **3.0** | No WAL, no log rotation, no auth on control plane, no exchange reconciliation on live boot, single container |
| **Scalability Score** | **2.5** | In-process bus, single Node process, per-symbol shared `subscribeAll` filter, unbounded tape/store maps |
| **Exchange Consistency Score** | **2.0** | Binance data ↔ CoinDCX execution drift unaddressed; symbol normalization inconsistent; mark drift uncorrected |
| **Risk Engine Safety Score** | **4.0** | Real invariants exist but are pre-trade only, race-prone, bypassable through legacy path, no live seed, drawdown kill default-off |

Overall verdict: **NOT FIT FOR UNATTENDED LIVE LEVERAGED TRADING** at the configured 10× default. Acceptable for paper research and small-size manual-supervised live with `MAX_NOTIONAL_USDT` ≤ 50 USDT and a daily wallclock cap.

---

## 3. Critical Issues (immediate halt-and-fix)

> Every CRITICAL below can independently cause >$10K loss on a $50K leveraged account. Most are reproducible deterministically.

### C-1 — Dual execution paths share an EventBus; legacy path bypasses RiskEngine and Allocator
**Components:** `src/orchestrator.ts` (1,943 LOC, owns `PositionManager`/`RiskManager`/exits), `src/core/actors/symbol-actor.ts`, `src/core/execution/signal-allocator.ts`, `src/core/risk/risk-engine.ts`, `src/index.ts:130-300`.

**Root cause:** `EVENT_BUS_EXECUTION_ENABLED` toggles whether the bridges (`SignalToOrderBridge`, `ExecutionBridge`) wire up, but the legacy orchestrator's `PositionManager.open()` is still constructed in `HybridOrchestrator`'s constructor (line 263) and is still callable. The orchestrator publishes its own events onto `defaultEventBus` via `MarketEventPublisher`. `ARCHITECTURE_TODO.md` line 167 explicitly admits: *"`src/orchestrator.ts` still owns multi-TF state + strategy dispatch; the `actorSystem` runs in parallel."* The commit log shows `d82da26 fix(critical): REVERSAL death spiral — disable legacy eval path under event-bus`.

**Failure scenario:** Legacy orchestrator fires `positionManager.open()` directly (no RiskEngine gate, no allocator, no cooldown). On the same tick, `SymbolActor.onKline` emits `strategy.signal` → `SignalToOrderBridge` → opposite-side order to a now-open position. Adapter rejects with `opposite_side_open_position_no_internal_reversal`, but the legacy fill already happened.

**Trading impact:** Uncontrolled double-orders, REVERSAL trades, state corruption between two position maps.

**Reproducibility:** Deterministic with `EVENT_BUS_EXECUTION_ENABLED=true` + `USE_SOL_MTF_STRATEGY=true` (both paths active).

**Recommended fix (tactical):** Pick one path. Make `HybridOrchestrator` stop owning strategy dispatch when `EVENT_BUS_EXECUTION_ENABLED=true` (delete legacy entry handlers, not just disable evals). Add a single assertion at startup: *exactly one execution path is wired*.

**Architectural fix:** Delete `HybridOrchestrator` strategy/position logic. Keep only the WS/REST market-data ingestion as a publisher to the bus. Strategies/risk/execution all live in the actor + bridge layer.

---

### C-2 — No order idempotency on the live CoinDCX path; REST retries can place duplicate orders
**Components:** `src/execution/coindcx-adapter.ts:82-93`, `src/coindcx/futures-client.ts`, `src/binance/rest-retry.ts`, `src/execution/retry-with-backoff.ts`.

**Root cause:** `CoinDcxExecutionAdapter.placeOrder` calls `client.createFuturesOrder({...})` with no `client_order_id`. The REST retry wrapper retries on 408/429/5xx (`rest-retry.ts:38-41`). POST `/order` is not idempotent. The Binance adapter does generate a `clientOrderId` for entry, but **not for the algo TP/SL** orders, and the algo service does not accept `clientOrderId` anyway.

**Failure scenario:** Order fills on the exchange at T=50ms; TCP timeout at T=52ms; retry fires at T=450ms; second fill of identical size at T=455ms; bot believes position size = N, exchange shows 2N; SL is sized for N; one liquidation cycle hits the unprotected N.

**Trading impact:** $50K-$200K on a 10× leveraged $20K margin per side on a single timeout.

**Reproducibility:** Reproducible with `iptables -A OUTPUT -p tcp --dport 443 -j DROP` after a TCP SYN to CoinDCX during a live entry.

**Recommended fix (tactical):** Add `client_order_id` to every CoinDCX REST call; for any non-idempotent POST, change retry policy to *do not retry on connection errors after the request was sent* (only retry on 5xx with explicit "no-side-effects" guarantees, which exchanges generally don't give).

**Architectural fix:** Implement a real OMS state machine (`NEW → SUBMITTED → ACK → PARTIAL → FILLED / REJECTED / CANCELLED`) keyed by client_order_id; on retry, GET `/openOrders` and `/userTrades` to detect the in-flight fill before resending. The `ARCHITECTURE_TODO.md` "Position state machine" section already calls for this.

---

### C-3 — Live mode boots with `RiskEngine.positions = {}`; opposite-side trades against an existing exchange position are allowed
**Components:** `src/index.ts:120-128`, `src/core/risk/risk-engine.ts:74-81`.

**Root cause:** `seedPositions()` is only invoked from `execution.paperAdapter`. There is **no** equivalent for `execution.cdcxAdapter` or `execution.binanceAdapter`. The Binance live adapter implements `restoreFromExchange()` but it is only invoked by the legacy orchestrator's `reconcileFromExchange` (best case). For the event-bus path on live, the engine simply starts empty.

**Failure scenario:** Bot was running LONG SOL 1 BTC notional yesterday, crashed without graceful shutdown. Operator restarts. RiskEngine has totalNotional=0. New SHORT signal fires; passes `OPPOSITE_SIDE_OPEN_POSITION` (no record); reaches adapter which knows nothing either; sent to exchange; exchange now has LONG and SHORT simultaneously (hedge mode) or flips position size (one-way mode), in both cases doubling margin.

**Trading impact:** Forced liquidation of either side; margin call; or worst-case, hedge-mode double exposure that pays the funding rate from both sides until manually closed.

**Reproducibility:** SIGKILL the bot mid-position, restart with same env.

**Recommended fix (tactical):** Make startup reconciliation a **synchronous, blocking, mandatory** step: query `getFuturesPositions()` (CoinDCX) or `getPositionRisk()` (Binance) before any strategy is allowed to publish a signal. If positions are found, seed RiskEngine and emit a `system.reconciled` event. If reconciliation fails, refuse to start.

**Architectural fix:** Add a `ReconciliationService` actor that runs at boot and on every reconnect of the private user-data WS, comparing exchange truth to internal state, emitting `position.drift` events when they disagree.

---

### C-4 — In-process synchronous EventBus has no backpressure, no DLQ, no isolation
**Components:** `src/core/events/event-bus.ts:48-72`.

**Root cause:** `publish()` iterates subscribers synchronously. Async callbacks have their rejections caught and logged to `console.error` but never re-queued, retried, or counted. Slow subscribers block the caller. There is no per-subscriber queue, no bound on subscriber call duration.

**Failure scenario:** `EventToPostgresBridge` blocks waiting for an over-loaded Postgres pool; `defaultEventBus.publish('market.kline.closed', …)` blocks; the WS multiplex message handler stalls; the WS receive buffer fills; Node socket back-pressures and starts dropping `message` events; mark price updates stop arriving; trailing stop manager never trails; SL never moves; price gaps through fixed SL on illiquid CoinDCX → 3-5× expected slippage.

**Trading impact:** Loss = (worst-case slippage during bus stall) × (qty). Easy $10K on a 1 BTC SOL position during a Fed announcement.

**Reproducibility:** `pg_ctl pause` Postgres for 30s while bot is live.

**Recommended fix (tactical):** Wrap every async subscriber in `setImmediate(() => cb(event))` so publishers never block. Add a per-subscriber unbounded queue with a high-water-mark metric. Add a `dead_letter` channel for permanently failed events.

**Architectural fix:** Move to **NATS JetStream** as proposed in `ARCHITECTURE_TODO.md` Phase 3 — per-consumer-group durable queues, real ack/retry, exactly-once via NATS' consumer state. This is the only way the system survives horizontal scale.

---

### C-5 — Control HTTP server has no authentication and can flatten or hot-swap the trading mode
**Components:** `src/control/http-server.ts`, `src/index.ts:443-462`.

**Root cause:** Server binds to `127.0.0.1:4002` (good) but accepts unauthenticated `POST /runtime/config`, `POST /runtime/kill`, `POST /runtime/unkill`. In container/Kubernetes networking, "localhost" can be reachable by anyone in the same network namespace (sidecars, port-forwarded shells, in-cluster attacker).

**Failure scenario:** Operator port-forwards the control port for debugging; forgets it. Adversary on shared network curls `/runtime/kill` mid-trade — open positions stay open but the bot stops managing them. Or worse, posts a config change to swap to testnet adapter mid-live and silently strands real positions.

**Trading impact:** Total loss of position management for the duration of the kill; arbitrary as long as the position is open.

**Reproducibility:** Trivial.

**Recommended fix (tactical):** Require a shared-secret bearer token (`CONTROL_AUTH_TOKEN`) on every state-changing route; refuse to start when token is unset. Log every request with source.

**Architectural fix:** Use mTLS, or a Unix domain socket bound to file mode 0600 owned by the bot user.

---

### C-6 — Symbol normalization is inconsistent between the data path (Binance UPPER) and execution path (CoinDCX `B-SOL_USDT`)
**Components:** `src/execution/coindcx-adapter.ts:40-48`, `src/strategy/position-manager.ts:73-81`, `src/core/execution/trailing-stop-manager.ts:84` and most exit managers, `src/core/execution/mark-price-bridge.ts`, `src/binance/ws-multiplex.ts:451`.

**Root cause:** Different normalizers in different layers (`getBaseAsset()` strips `B-`, `_USDT`, `USDT`, `PERP`, `-`; mark-price bridge uses `symbol.toUpperCase()`; CoinDCX adapter does `pair.replace(/^B-/, '').replace('_', '')`; multi-tf-store uses an arbitrary key function). Fill events from CoinDCX user-data WS carry `data.pair` (= `B-SOL_USDT`); fill events synthesized by `ExecutionBridge` from a Binance adapter carry `SOLUSDT`. Exit managers and the RiskEngine key by whatever they received.

**Failure scenario:** Trailing stop registered under `SOLUSDT` while CoinDCX user-data WS publishes `execution.position.closed` with `symbol: 'B-SOL_USDT'`; trailing stop never receives the close event; keeps trailing a position the exchange has already closed; later, on a kline update, it requests another close → adapter returns `live_close_unknown_order` → silent failure → ghost trailing.

**Trading impact:** Held-forever positions; orphan exit managers consuming events; misaligned PnL.

**Recommended fix (tactical):** Add a single `normalizeSymbol(s: string)` utility used everywhere; normalize at the bus boundary (in `MarketEventPublisher` and `CoinDcxUserDataWs`) before publishing.

**Architectural fix:** Introduce a `Symbol` value object with `binance`, `coindcx`, `canonical` fields, populated once at the mapping layer (`src/mapping/symbol-map.ts`), and pass it through the event payloads instead of strings.

---

### C-7 — Stale market-data detection is advisory, not enforcing; no automatic risk-off on feed loss
**Components:** `src/ai/stale-guard.ts`, `src/orchestrator.ts:420, 505-507` (ltp watchdog), `src/core/execution/execution-bridge.ts`.

**Root cause:** `StaleGuard` defines staleness but there is no subscriber on `ExecutionBridge` or `RiskEngine` that consults it. `ltpConfirmed=false` resets on reconnect but no subsystem refuses to send orders while not confirmed. The 23-hour rotation timer simultaneously closes all routes; the reconnect uses exponential backoff to 60s; up to a minute of pure blindness is possible at a deterministic wall-clock time.

**Failure scenario:** WS rotates at 23h; reconnect fails 5 times due to Binance burst rate-limit; for 60s, no klines, no marks, no bookticker; strategy fires on stale features; ExecutionBridge sends order; CoinDCX fills at a price 1-2% away from the cached reference.

**Trading impact:** $5K-$50K per blackout depending on volatility.

**Recommended fix:** Add a `system.stale` event emitted by a freshness watchdog; subscribe RiskEngine to it; reject all `execution.order.requested` while stale. Add jitter to the 23h rotation (random 0–2h offset) and stagger routes.

**Architectural fix:** Make freshness a first-class invariant of the bus: every event carries a `dataAgeMs`; bridges discard expired events.

---

### C-8 — Postgres event store can silently drop events; no write-ahead log
**Components:** `src/persistence/pg-writer.ts:223-246, 256-284`, `src/persistence/event-store.ts`.

**Root cause:** `PgWriter.appendEvent` enqueues to a 10,000-cap in-memory queue. On overflow, `splice(0, drop)` discards oldest events and bumps `droppedEvents` — *not exposed as a metric*. Flush failures `console.warn` and **do not re-queue**. The "audit log" is best-effort.

**Failure scenario:** Postgres CPU pegged at 100% during a busy market session; pool fills; writes timeout; `eventQueue` overflows; oldest events (including the `execution.order.filled` for the open position) get discarded; bot crashes 5min later; restart reads Postgres positions table → no record → opens *another* position.

**Trading impact:** Loss of audit trail; double-positioning on restart; tax/regulatory exposure.

**Recommended fix:** Local WAL (RocksDB / SQLite / append-only file) ahead of Postgres. Replay WAL on startup. Expose `pg_writer_dropped_events_total` as a Prometheus counter. Set `statement_timeout` on the pool. Telegram-alert on first drop.

**Architectural fix:** NATS JetStream's durable streams replace the in-process queue entirely.

---

### C-9 — Disaster recovery: in-memory state is the source of truth for half the system
**Components:** `src/index.ts`, `src/core/risk/risk-engine.ts`, `src/strategy/position-manager.ts`, `src/core/execution/trailing-stop-manager.ts`, `src/core/execution/tp-ladder-manager.ts`, `src/core/execution/structure-exit-manager.ts`.

**Root cause:** RiskEngine positions, PositionManager positions, every exit manager's in-memory map of open positions, paper FundingEngine accrual, paper LiquidationEngine state — **all in-memory only**. Wallet.json and Postgres are partial mirrors. There is no event-sourced rebuild on restart.

**Failure scenario:** Host OOM-killed → systemd restart → bot rejoins WS → has no idea that 4 exits were armed on SOL/ETH/BTC/XRP. CoinDCX has positions. Strategy keeps firing.

**Recommended fix:** On boot, after exchange reconciliation, re-emit synthetic `execution.order.filled` events with original entry metadata so every exit manager re-arms. This requires persisting entry metadata (`atr`, `initialStop`, `tpLadder`, `partialDone`, `highWater`) in Postgres at fill-time.

**Architectural fix:** Move to event-sourced state: every actor reconstructs its state by replaying its event journal at startup. NATS JetStream stream-per-symbol gives this naturally.

---

### C-10 — Repaint / lookahead structural bugs in SMC analysis and bar storage
**Components:** `src/strategy/smc.ts:163-167`, `src/binance/multi-tf-store.ts:54-76` (`insertCandle` overwrite), `src/strategy/smc-confluence.ts:23-33`, `src/strategy/htf-ltf.ts:19-26`.

**Root cause:**
- `analyzeSmc` reads `candles[i+1]` for FVG fill detection. On the live tip of the series, the "next" candle is the in-progress one or doesn't exist yet — depending on timing, the boundary check `i+1 < n` passes but `candles[i+1]` is the *current* bar that hasn't closed.
- `MultiTimeframeStore.insertCandle` overwrites by `openTime` match unconditionally — a late-arriving non-final kline with the same `openTime` can overwrite a sealed (`isFinal=true`) bar.
- HTF bias EMA(9/21) reads `closes[i]` where `i = closes.length-1`, i.e. the most recent (possibly in-progress) close.

**Trading impact:** Backtests look great because they only run on closed history; live shows materially different signals on the same nominal setup. Strategy edge is fictitious.

**Recommended fix:** Add a `sealed: boolean` per bar; once `true`, `insertCandle` refuses overwrite. Indicators run on `closes.slice(0, sealedCount)` only. All `[i+1]` access requires `sealed[i+1] === true`.

**Architectural fix:** Pure functions over an immutable closed-bar series; in-progress bar is a separate field, never indexed by lookback math.

---

## 4. High-Risk Issues

### H-1 — Bracket order race: SL can fire during async `cancelAllAlgoOrders` after TP1 fill
**Components:** `src/execution/binance-adapter.ts:417-451, 441-444`.
**Root cause:** `notifyFilled` for TP1 fires `Promise.allSettled([cancelAllAlgoOrders(), cancelAllOrders()])` *without await*. Window of 100ms-1s between TP1 fill and actual cancel.
**Fix:** Make the SL cancel **synchronous, sequential, awaited** before returning from `notifyFilled(tp1)`. Mark trade state `pendingCancel` and refuse subsequent SL `notifyFilled` while pending.

### H-2 — `RiskEngine.onFilled` aggregation arithmetic is wrong for partial closes / reversals
**Components:** `src/core/risk/risk-engine.ts:164-187`.
**Root cause:** `onFilled` always *adds* to existing notional with `prev.notional + notional`. There is no handling for `reduceOnly` fills (TP1 partial close) or for opposite-side fills (REVERSAL). When TP1 fires, it emits a fill-shaped close event in some paths and a `position.closed` in others. The legacy adapter close callback (`src/index.ts:374-407`) publishes `execution.position.closed` synthesized from a `ClosedPosition` — but the partial TP1 paths don't always reach this.
**Fix:** Distinguish `OPEN_FILL`, `INCREASE_FILL`, `REDUCE_FILL`, `CLOSE_FILL` payload types; RiskEngine handles each separately.

### H-3 — Live `CoinDcxUserDataWs` translates `active_pos > 0` to `execution.order.filled` for every position update — duplicates the original fill
**Components:** `src/coindcx/user-data-ws.ts:113-164`.
**Root cause:** `onPosition` fires `execution.order.filled` for every position_update with `active_pos > 0`, including subsequent updates from mark moves or partial closes. RiskEngine and TrailingStopManager both subscribe to `execution.order.filled` and treat each as a *new* fill (pyramiding the in-memory notional).
**Fix:** Deduplicate by `orderId`; only publish a fill when `active_pos` *increases* compared to the previous update for that orderId.

### H-4 — `SignalToOrderBridge` cooldown is per-symbol, not per (symbol, side, strategyId); same bar can flip-flop signals
**Components:** `src/core/execution/signal-to-order-bridge.ts:50-52`.
**Fix:** Hash on `(symbol, side, strategyId, closeTime)` and dedupe explicitly.

### H-5 — `LiveAccountPoller` `missConfirms=3` × 5s poll = up to 15s of staleness before a live close is observed
**Components:** `src/core/execution/live-account-poller.ts`, `src/index.ts:174-188`.
**Fix:** Drop to `missConfirms=1` when WS is connected; rely entirely on the user-data WS and use REST polling only as a presence check, not as the source of truth for closes.

### H-6 — `MAX_NOTIONAL_USDT` defaults to **0 (disabled)**, `DAILY_DRAWDOWN_KILL_PCT` defaults to **0 (disabled)**, `MAX_OPEN_POSITIONS` defaults to **0 (unlimited)**, `MAX_TOTAL_EXPOSURE_USDT` default 100k — most risk caps are off-by-default
**Components:** `src/config.ts:138, 488, 499, 502`.
**Fix:** Set sane non-zero defaults (`MAX_NOTIONAL_USDT=200`, `MAX_OPEN_POSITIONS=3`, `DAILY_DRAWDOWN_KILL_PCT=0.05`) and refuse to boot in `EXECUTION_MODE=live` until they are explicitly set in env.

### H-7 — Notional cap is per-order; pyramiding bypasses it
**Components:** `src/core/risk/risk-engine.ts:111-114`, paper adapter pyramid path `src/execution/paper/adapter.ts:76-105`.
**Fix:** Enforce `existing.notional + orderNotional ≤ MAX_NOTIONAL_USDT` on every add.

### H-8 — Binance WS depth diff buffer is capped at 200 (`src/binance/orderbook.ts:58-65`)
**Root cause:** Binance spec requires buffering all diffs until snapshot arrives. Slow REST = book corruption.
**Fix:** Increase to 5000 and surface buffer occupancy as a metric; if `now - buffered[0].E > 30s`, force REST refetch.

### H-9 — `ExecutionBridge.lookupLiqPrice` calls `getOpenPositions()` synchronously **inside the synchronous bus dispatch** for every fill
**Components:** `src/core/execution/execution-bridge.ts:122-129`.
**Fix:** Plumb `liqPrice` through the adapter's `OrderResult`.

### H-10 — Funding engine accrual uses snapshot notional at the moment of `nextFundingTime`, not time-weighted average
**Components:** `src/execution/paper/funding.ts:71-107`.
**Fix:** Integrate notional × Δt across the 8h window for paper funding to match exchange behavior.

### H-11 — Paper liquidation fires instantly at zero latency, zero slippage
**Components:** `src/execution/paper/liquidation.ts`, `src/execution/paper/adapter.ts:229-234`.
**Fix:** Add 100-500ms latency + worst-side slippage on liquidation fills to match exchange AMM behavior.

### H-12 — `ScriptWorker` uses `new Function(...)` for user scripts inside a worker thread
**Components:** `src/core/runtime/script-worker.ts`.
**Root cause:** `__proto__` / `constructor` chain escape is possible (acknowledged in `ARCHITECTURE_TODO.md` Phase 2).
**Fix:** Migrate to `isolated-vm` with `memoryLimit` and execution timeout.

### H-13 — Telegram notifier subscribes to bus; no axios timeout
**Components:** `src/services/telegram-notifier.ts`.
**Root cause:** A slow Telegram call back-pressures the synchronous bus.
**Fix:** `axios.create({ timeout: 3000 })`; wrap subscriber in `setImmediate`.

### H-14 — ML gate fails open
**Components:** `src/ai/inference-client.ts`, `src/ai/ml-gate.ts`.
**Root cause:** When Ollama is unreachable, `predict()` returns null; the strategy proceeds without ML filter.
**Fix:** Fail-closed; reject signals if ML enabled and inference unavailable for > N seconds.

### H-15 — Synchronous `appendFileSync` for every NDJSON log line + no rotation
**Components:** `src/logging/app-logger.ts`.
**Fix:** `pino` with `sonic-boom`, daily rotation, PII redaction.

### H-16 — Lifecycle does not register `TelegramNotifier`, `ControlHttpServer`, EventBus unsubscribers
**Components:** `src/index.ts:102, 444-462`, `src/lifecycle.ts`.
**Fix:** Register all stoppables.

---

## 5. Medium-Risk Issues

| ID | Title | Component | Fix |
|---|---|---|---|
| M-1 | `MultiTimeframeStore` per-symbol × per-tf is unbounded — config misconfig (5000-symbol watchlist) → OOM | `src/binance/multi-tf-store.ts` | Hard cap on unique symbols at construction |
| M-2 | Redis `enableOfflineQueue:false` + `maxRetriesPerRequest:3` — transient blips drop commands silently | `src/services/redis.ts` | Reconnect strategy with exp backoff; `enableOfflineQueue:true` |
| M-3 | `CorrelationGuard` loaded once from `CORRELATION_PAIRS_JSON` env, never updated | `src/risk/correlation-guard.ts` | Recompute rolling 30-day corr nightly; allow runtime update via Redis pubsub |
| M-4 | `SymbolActor.subscribeAll` filters by `event.symbol !== this.symbol` — every actor sees every event (O(N) per event for N symbols) | `src/core/actors/symbol-actor.ts:48-66` | Subscribe per-event-type with symbol filter |
| M-5 | Replay engine event-store excludes `market.bookticker` and `market.depth.delta` — replays run on empty orderbook | `src/persistence/event-store.ts`, `src/replay/replay-engine.ts` | Optional firehose mode; record 1-Hz book snapshots |
| M-6 | Single-route 24h reconnect with no jitter — predictable blackout window | `src/binance/ws-multiplex.ts:641-648` | Random jitter 0-2h; stagger per route |
| M-7 | REST `Retry-After` header capped by `BINANCE_REST_RETRY_MAX_MS=20s` — during real 60s rate-limit punishment, this thrashes | `src/binance/rest-retry.ts` | Honor `Retry-After` up to 5 minutes; queue requests instead of retry-spamming |
| M-8 | Time skew: WS event handlers fall back to `Date.now()` when `E` is missing (`src/binance/ws-multiplex.ts:467, 481, 491`) | | Sync local clock to `/fapi/v1/time` offset; never fall back |
| M-9 | `BookTicker` events do not carry sequence numbers but are used for paper fills — out-of-order ticks fill wrong direction | `src/binance/ws-multiplex.ts:455-468`, `src/execution/paper/book-ticker-feed.ts` | Track `updateId` (already in payload but not validated) and discard out-of-sequence |
| M-10 | `correlationPositionCache` TTL 5s and shared between concurrent guards — race window | `src/orchestrator.ts:215-216` | Move to RiskEngine, refresh on `execution.order.filled` |
| M-11 | `SHADOW_MODE` flag is checked in `PositionManager` but not in `ExecutionBridge` | `src/safety/shadow-mode.ts` vs `src/core/execution/execution-bridge.ts` | Add an explicit shadow-aware wrapping at adapter construction in `createExecutionRuntime` |
| M-12 | Anomalous-bar callback in `MultiTimeframeStore.checkAnomaly` (range > 8× median) *drops the bar* — strategy misses real volatility events | `src/binance/multi-tf-store.ts:82-94` | Always store; log without dropping |
| M-13 | `Dockerfile` healthcheck probes `/metrics` only — does not detect strategy staleness | `Dockerfile` | Dedicated `/health` that checks last kline age and event-bus lag |
| M-14 | `paper-adapter.test.ts` does not test partial fills, queue position, or top-of-book exhaustion; `coindcx-adapter.test.ts` nock stubs are minimal | `tests/*` | Add parametric mocks for response shape variants and partial-fill paths |
| M-15 | `defaultEventBus` is a module-level singleton — impossible to dispose, hidden coupling for tests | `src/core/events/event-bus.ts:81` | DI everywhere; delete the singleton |
| M-16 | `EventStore.startRecording()` is called once, never stopped (`ARCHITECTURE_TODO.md:168-169`) | `src/persistence/event-store.ts` | `Lifecycle.register` |
| M-17 | `INR_PER_USDT` baked into PnL math; FxRateService refresh is best-effort, no staleness ceiling | `src/services/fx-rate.ts` | Reject conversions when rate is > 5 minutes stale |
| M-18 | `SignalAllocator` `flushDelayMs=1500ms` discards same-bar same-symbol second signals as `WORSE_THAN_TOP_CANDIDATES` — no queue retry for next bar | `src/core/execution/signal-allocator.ts:88-110` | Cross-bar queue for runners-up |
| M-19 | `position.entryPrice` in `RiskEngine.onFilled` is recomputed as `newNotional / newQty` — fee-paid notional drift not modeled | | Track entry price + qty separately |
| M-20 | `binance-adapter.ts` `attachAlgoTpSl` does not await all three placements; if SL `placeAlgoOrder` rejects after TP1/TP2 succeed, position is **TP-only**, no SL — silent | `src/execution/binance-adapter.ts:629-719` | Roll back TP placements on SL failure; or refuse entry |

---

## 6. Low-Risk Issues

| ID | Title |
|---|---|
| L-1 | `multi-tf-store.prependOlder` doc says "value already in series wins" but code does the opposite |
| L-2 | `DepthChangeTracker` only sees top-N levels; misses cascade beyond depth 20 |
| L-3 | `getBaseAsset` strips `_USDT` and then `USDT`, so `B-DOGE_USDT` and `DOGEUSDT` both → `DOGE` — but `1000PEPEUSDT` → `1000PEPE` works by luck, not by design |
| L-4 | Many test files mock at adapter level with `fillPriceScale=1`, fees=0 — backtests over-optimistic |
| L-5 | `LocalOrderBook.applyDiff` returns false on stale diff *and* on desync, indistinguishably |
| L-6 | Numerous `as any` casts at config access (`(cfg as any).SEYKOTA_ENABLED`) — type safety bypassed for new fields |
| L-7 | `PostgresPool.connectionTimeoutMillis: 5000` is aggressive — every restart hammers PG during boot |
| L-8 | Comment-doc mismatch in `SignalAllocator` re: "subscribe BEFORE RiskEngine" — actual subscription order is JS module-load order, fragile |
| L-9 | `private-ws.ts` listenKey renew retries are **not** rescheduled on failure — next attempt is 30 min later |
| L-10 | `tests/replay-determinism.test.ts` only verifies byte-equal event sequence, not strategy output |

---

## 7. Deep Gap Analysis — Missing Subsystems

| Missing | Severity | Why it matters |
|---|---|---|
| **Order Management System / state machine** | CRITICAL | The entire order lifecycle is implicit; `ARCHITECTURE_TODO.md` already calls for it. No `NEW/SUBMITTED/ACK/PARTIAL/FILLED/CANCELLED/REJECTED` enum. |
| **Reconciliation service** | CRITICAL | Currently a one-shot, paper-only `seedPositions`. No periodic, no live, no drift detection. |
| **Execution journal / write-ahead log** | CRITICAL | PgWriter is the journal *and* the only mirror. Need a local append-only file with crash-safe fsync ahead of all bus side-effects. |
| **Deterministic replay with full firehose** | HIGH | Backtest fidelity is fundamentally broken without bookticker/depth replay. |
| **Stream-aligner enforcement** | HIGH | Stale features can produce a signal that bypasses every guard. |
| **Distributed lock for cross-symbol risk** | HIGH | At scale, "total notional" + "correlation guard" cannot live in one Node process. |
| **Dead-letter queue / DLQ on bus** | HIGH | Persisting failed events for forensic analysis. |
| **Circuit breaker / kill-switch wired into the event bus** | HIGH | `kill_switch` lives only in Redis state; orders can still be placed by paths that don't poll it. |
| **Exchange failover** | MEDIUM | Binance and CoinDCX are both single points of failure; data feed has no Binance-spot fallback for SOL price. |
| **Drawdown lock / loss streak lock / overtrading guard** | HIGH | `ARCHITECTURE_TODO.md` Phase 2 already lists these as missing. |
| **Liquidation-proximity reject** | HIGH | Reject new entries when mark within K·ATR of liq price. |
| **Funding spike reject** | MEDIUM | Reject open when `|funding|*8h > X bps`. |
| **Bracket atomicity** | HIGH | TP+SL+entry need to be transactional or rolled back. Binance batchOrders helps for the entry+SL+TP1 case but is fallback-only. |
| **Per-symbol mailbox / serialized actor** | HIGH | Currently no message ordering guarantee per symbol. |
| **Sandboxed strategy runtime** | HIGH | `new Function(...)` is unsafe. |
| **Observability: position drift, equity mismatch, strategy staleness, fill-latency P99** | HIGH | Trading metrics not in Prometheus exporter. |
| **Alertmanager rules** | MEDIUM | No alerts configured. |
| **PII redaction in logs** | MEDIUM | Keys / Telegram IDs in NDJSON. |
| **Chaos / property tests** | MEDIUM | No fault injection, no fuzz, no race-condition tests. |
| **Workflow orchestrator (Temporal / NATS JetStream consumer groups)** | LONG-TERM | The trade lifecycle is a long-running workflow; today it's a tangle of bus events. |

---

## 8. Recommended Institutional-Grade Target Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     CONTROL PLANE (mTLS, RBAC)                  │
│   kill-switch · config push · canary toggle · audit query       │
└─────────────────────────────────────────────────────────────────┘
                ▲                                  ▲
                │                                  │
┌───────────────┴────────────┐    ┌────────────────┴───────────┐
│ MARKET-DATA INGRESS        │    │ EXECUTION ACCOUNT INGRESS  │
│   service-per-exchange     │    │   per-exchange user-data WS│
│   - Binance MD             │    │   - Binance privateWs      │
│   - CoinDCX MD (parity)    │    │   - CoinDCX userdata       │
│   Normalises symbols, time │    │   Normalised fill/balance  │
│   Publishes to NATS:       │    │   events to NATS           │
│     market.kline.<sym>     │    │     execution.fill.<sym>   │
│     market.book.<sym>      │    │     execution.balance      │
│     market.trade.<sym>     │    │                            │
│     market.mark.<sym>      │    │                            │
└─────────────┬──────────────┘    └─────────────┬──────────────┘
              │                                  │
              ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                   EVENT BACKBONE — NATS JetStream                │
│   durable streams · consumer groups · DLQ · WAL · exactly-once   │
│   topics partitioned by symbol → horizontal scale                │
└─────────────────────────────────────────────────────────────────┘
              ▲                                  │
              │                                  ▼
┌─────────────┴──────────────┐    ┌────────────────────────────────┐
│ STRATEGY RUNTIME           │    │ PORTFOLIO + RISK SERVICE       │
│  - SymbolActor (1 leader   │    │  - global exposure             │
│    per symbol via Redis    │    │  - correlation                 │
│    leader lock)            │    │  - drawdown                    │
│  - StrategyModule plugins  │    │  - liquidation-proximity       │
│  - sandboxed user scripts  │    │  - per-symbol caps             │
│    (isolated-vm)           │    │  - kill-switch                 │
│  Emits strategy.signal     │    │  Gates execution.order.req     │
└─────────────┬──────────────┘    └─────────────┬──────────────────┘
              │                                  │
              ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│           ORDER MANAGEMENT SERVICE (OMS) — per exchange         │
│   - client_order_id idempotency cache (Redis, 24h TTL)          │
│   - explicit OrderStateMachine (NEW→…→FILLED/REJ/CANC)          │
│   - bracket as single transactional unit (compensating txns)    │
│   - rate-limit aware queue                                      │
│   - reconciler: every 30s, diff with exchange truth             │
└─────────────────────────────────────────────────────────────────┘
              │                                  │
              ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│            EXCHANGE ADAPTERS (no logic, just HTTP/WS)           │
│   binance-adapter   coindcx-adapter   paper-adapter             │
└─────────────────────────────────────────────────────────────────┘
              │                                  │
              ▼                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│  PERSISTENCE         OBSERVABILITY            DISASTER RECOVERY │
│  - local WAL         - OpenTelemetry traces   - hot standby     │
│  - TimescaleDB for   - Prom metrics + alerts    in another AZ   │
│    klines/fills      - Grafana dashboards     - cross-region    │
│  - Postgres OLTP     - structured JSON logs     event stream    │
│    for OMS state                                replication     │
└─────────────────────────────────────────────────────────────────┘
```

### Recommended technologies

- **Bus:** NATS JetStream (Phase 3 in repo's own roadmap) — lightweight, ack/retry, durable. Kafka if you grow past 50k msg/s.
- **OMS state:** Postgres logical-replicated; in-memory cache rebuilt from journal.
- **Replay:** Same code path as live, driven by JetStream consumer reading from the start of stream. Inject `MarketClock` from event.ts (already done).
- **Sandboxing:** `isolated-vm` with `memoryLimit: 64` and `timeout: 2_000`.
- **Observability:** OpenTelemetry instrumentation on adapters + bus consumers; Prometheus for counters/gauges; Grafana with alert rules.
- **Disaster recovery:** State snapshots every 60s to S3-compatible object store + JetStream stream replication to a second region.

### Bounded contexts

1. **Market Data** — pure ingestion, normalisation, distribution
2. **Strategy** — pure signal generation, no I/O
3. **Risk** — gates orders, owns global state invariants
4. **Order Management** — lifecycle, idempotency, reconciliation
5. **Account** — wallets, balances, PnL, equity, funding
6. **Persistence** — event journal, OLTP, analytics
7. **Control / Audit** — auth, kill-switch, query, replay

---

## 9. Migration Plan (priority-ordered, with calendar weeks)

### Sprint 0 — Stop the bleeding (Week 1; ~3 dev-days)
1. **Disable live** until C-1, C-2, C-3, C-5 are fixed. Trade paper only.
2. Add `client_order_id` to every CoinDCX REST call **or** disable retry on POST `/order`.
3. Wire mandatory exchange reconciliation at startup for both adapters.
4. Add token auth to Control HTTP.
5. Set sane defaults: `MAX_NOTIONAL_USDT=200`, `MAX_OPEN_POSITIONS=3`, `DAILY_DRAWDOWN_KILL_PCT=0.05`.
6. Telegram alert on `pg_writer_dropped_events_total > 0` and on every position reconciliation drift.

### Sprint 1 — Cut over to single execution path (Week 2-3)
1. Delete legacy `PositionManager`/`RiskManager`/exit logic from `HybridOrchestrator`. Make it a pure market-data ingestion + WS lifecycle module.
2. Make every fill / close go through the event bus only.
3. Implement `OrderStateMachine` keyed by `clientOrderId`; reconcile on `ORDER_TRADE_UPDATE` / CoinDCX `order_update`.
4. Normalise symbols at bus boundary.
5. Add `system.stale` event; RiskEngine subscribes and rejects orders while stale.

### Sprint 2 — Durability (Week 4-5)
1. Local WAL (SQLite or append-only file with fsync) ahead of PgWriter.
2. Persist exit-manager arm state (`atr`, `initialStop`, `highWater`, `tpLadder`, `partialDone`) per fill.
3. Re-emit synthetic fill events on restart so exit managers re-arm.
4. Log rotation + redaction (pino).
5. Restart policy + `stopGracePeriod: 30s` in compose; real `/health` endpoint.

### Sprint 3 — Observability (Week 6)
1. Prometheus: `event_bus_callback_errors_total`, `pg_writer_queue_depth`, `pg_writer_dropped_events_total`, `position_drift_usdt`, `strategy_staleness_sec{symbol}`, `fill_latency_ms` histogram, `risk_rejections_total{reason}`.
2. Alertmanager rules + PagerDuty integration.
3. OpenTelemetry trace on order placement (request → adapter → exchange → fill event).

### Sprint 4 — Bus migration to JetStream (Month 2)
1. Wrap `EventBus` with a NATS-backed implementation behind the same interface.
2. Move every subscriber to a consumer group.
3. Replace `defaultEventBus` singleton with DI.

### Sprint 5 — Strategy sandboxing, sandboxed user scripts (Month 2-3)
1. `isolated-vm` with memory + CPU caps.
2. Per-symbol mailbox (serialized handler queue).

### Sprint 6 — Horizontal scale + DR (Month 3+)
1. Symbol-sharding via Redis leader-lock per symbol.
2. Cross-region JetStream replication.
3. Hot standby instance with leader election.

---

## 10. Prioritised Fix-Order (one-screen)

1. **C-2** Idempotency on CoinDCX live POST `/order` *(blocks live trading)*
2. **C-3** Exchange reconciliation on every boot for live adapters *(blocks live trading)*
3. **C-5** Auth on Control HTTP *(security)*
4. **C-1** Single execution path; delete legacy strategy dispatch
5. **C-6** Canonical symbol object across bus
6. **H-1** Synchronous SL cancel on TP1 fill
7. **C-7** Stale-feed guard; risk-off on staleness; jitter the 23h rotation
8. **C-4** Async subscriber dispatch; queue-per-subscriber; DLQ
9. **C-8** Local WAL ahead of Postgres; never drop events
10. **C-9** Persist + re-emit fill metadata on restart to re-arm exit managers
11. **C-10** Sealed-bar invariant; closed-bar-only indicators; remove `[i+1]` lookahead
12. **H-2**, **H-3**, **H-4**, **H-5**, **H-13**, **H-14**, **H-16** in parallel
13. **H-6** Risk-cap defaults; refuse to boot live without explicit values
14. **H-12** `isolated-vm` for ScriptWorker
15. Sprint 3+: observability, NATS, sharding, DR

---

## 11. Closing Assessment

The author has clearly done institutional-grade *thinking* — `ARCHITECTURE_TODO.md` already names most of the gaps this audit confirms (OMS state machine, NATS migration, per-symbol mailbox, isolated-vm, off-process bus, scaled risk). The roadmap is honest. The execution is a serious paper trading engine and a strong Binance-data layer, but the live execution path — *especially the CoinDCX path that's the production target* — is built on the same idioms as the paper path, where idioms like "fire-and-forget order with retries" are safe.

Treat this codebase as **a production-grade research platform with a live-trading prototype attached**, not as a production trading system. Until C-2, C-3, C-5, C-6, C-7 are resolved, **do not run it unattended on more than tens of USDT of margin**, and consider whether the hybrid Binance-data/CoinDCX-execution model is even the right design: a single-exchange architecture (Binance USDM, where the entire data + execution + account stack is one consistent venue) would eliminate the biggest class of risks this report has surfaced.
