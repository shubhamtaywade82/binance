import { EventBus } from '../events/event-bus';
import { DomainEvent, OrderRequestedPayload } from '@coindcx/contracts';
import { AppConfig } from '../../config';
import { marketClock } from '../time/market-clock';
import { RiskEngine } from '../risk/risk-engine';

interface BufferedCandidate {
  event: DomainEvent<OrderRequestedPayload>;
  score: number;
}

/**
 * SignalAllocator — best-of-bar selection.
 *
 * Without this, every strategy emits execution.order.requested independently
 * and the first one through wins regardless of quality. On a strong trend day
 * 3-4 symbols can fire on the same 5m close; the FCFS winner is just the
 * symbol whose WS message landed earliest, not the highest-conviction trade.
 *
 * The allocator:
 *   1. Intercepts execution.order.requested (subscribes BEFORE RiskEngine).
 *   2. Buffers candidates that share a closeTime (5m kline boundary).
 *   3. After `flushDelayMs` since the first candidate in a window, scores
 *      every candidate and forwards the top N to the RiskEngine while
 *      rejecting losers with reason WORSE_THAN_TOP_CANDIDATES.
 *   4. N = max(0, MAX_OPEN_SYMBOLS - currentlyOpen).
 *
 * Score formula (Seykota-style trend strength):
 *   score = ((adx - adxThreshold) / 10) × (atrPct / minAtrPct)
 * Higher ADX + higher relative ATR = stronger, more tradeable trend.
 *
 * Implementation note: this works by re-publishing forwarded candidates onto
 * a separate channel `execution.order.requested.allocated` that the RiskEngine
 * subscribes to. To keep the upstream contract unchanged we subscribe to the
 * raw `execution.order.requested` and have the RiskEngine subscribe to
 * `execution.order.requested.allocated`. The allocator is opt-in via cfg.
 */
export type AllocatorMode = 'score' | 'fcfs';

export class SignalAllocator {
  private buckets = new Map<number, BufferedCandidate[]>();
  private flushTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly flushDelayMs: number;
  private readonly adxThreshold: number;
  private readonly minAtrPct: number;
  private seq = 0;
  private readonly mode: AllocatorMode;
  /**
   * M-18: runners-up from the previous bar(s) that could not fit in the
   * MAX_OPEN_SYMBOLS budget. Re-evaluated at the start of the next flush
   * (score mode) or on every position close (FCFS mode): if a slot opened
   * up, the head of the queue takes it. Bounded by `carryoverCapacity`
   * so a chronically over-firing strategy doesn't grow this queue
   * unboundedly. FCFS preserves arrival order; score replays by score.
   */
  private carryover: BufferedCandidate[] = [];
  private readonly carryoverCapacity: number;
  private readonly carryoverMaxAgeMs: number;

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly riskEngine: RiskEngine,
    opts: { flushDelayMs?: number; carryoverCapacity?: number; carryoverMaxAgeMs?: number; mode?: AllocatorMode } = {},
  ) {
    this.flushDelayMs = opts.flushDelayMs ?? 1500;
    this.adxThreshold = Number((cfg as any).SEYKOTA_ADX_THRESHOLD) || 20;
    this.minAtrPct = Number((cfg as any).SEYKOTA_MIN_ATR_PCT) || 0.003;
    this.carryoverCapacity = Math.max(0, opts.carryoverCapacity ?? 20);
    this.carryoverMaxAgeMs = Math.max(0, opts.carryoverMaxAgeMs ?? 60_000); // 1 bar's worth
    this.mode = opts.mode ?? ((cfg as any).SIGNAL_ALLOCATOR_MODE as AllocatorMode) ?? 'score';
    this.subscribe();
  }

  /**
   * FCFS reservation: a symbol forwarded but not yet visible in RiskEngine
   * exposure (RiskEngine only updates positions on fills). Without this
   * counter, multiple simultaneously-arriving signals all see exposure=0
   * and over-allocate past MAX_OPEN_SYMBOLS.
   */
  private pendingSymbols = new Set<string>();

  private subscribe(): void {
    this.eventBus.subscribe<OrderRequestedPayload>('execution.order.requested', (e) => {
      if (this.mode === 'fcfs') this.handleFcfs(e);
      else this.bufferCandidate(e);
    });
    if (this.mode === 'fcfs') {
      this.eventBus.subscribe('execution.order.rejected', (e: DomainEvent<any>) => {
        const sym = (e.symbol ?? e.payload?.symbol ?? e.payload?.requested?.symbol) as string | undefined;
        if (sym) this.pendingSymbols.delete(sym);
        this.drainCarryoverFcfs();
      });
      this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
        const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
        if (sym) this.pendingSymbols.delete(sym);
        this.drainCarryoverFcfs();
      });
    }
  }

  private effectiveOpenSymbols(): number {
    const exposure = this.riskEngine.getExposure();
    let n = exposure.symbols;
    for (const s of this.pendingSymbols) {
      if (!exposure.positions.has(s)) n += 1;
    }
    return n;
  }

  /** M-18: observability — current carryover depth (runners-up awaiting a slot). */
  public carryoverDepth(): number {
    return this.carryover.length;
  }

  private bufferCandidate(event: DomainEvent<OrderRequestedPayload>): void {
    const p = event.payload;
    if (!p.score) {
      // Legacy strategy without score → pass through immediately.
      this.forward(event);
      return;
    }
    const closeTime = p.score.closeTime;
    if (!this.buckets.has(closeTime)) this.buckets.set(closeTime, []);
    this.buckets.get(closeTime)!.push({ event, score: this.computeScore(p) });

    if (!this.flushTimers.has(closeTime)) {
      const timer = setTimeout(() => this.flushBucket(closeTime), this.flushDelayMs);
      this.flushTimers.set(closeTime, timer);
    }
  }

  /**
   * FCFS: no window, no sort. First signal per symbol claims a free slot.
   * Adds to existing symbol pyramid immediately. Otherwise queues FIFO
   * (bounded) until a position closes.
   */
  private handleFcfs(event: DomainEvent<OrderRequestedPayload>): void {
    const sym = event.payload.symbol;
    const exposure = this.riskEngine.getExposure();
    const already = exposure.positions.has(sym) || this.pendingSymbols.has(sym);
    const maxSymbols = Number((this.cfg as any).MAX_OPEN_SYMBOLS) || Infinity;
    const slotsLeft = Math.max(0, maxSymbols - this.effectiveOpenSymbols());
    if (already || slotsLeft > 0) {
      if (!already) this.pendingSymbols.add(sym);
      this.forward(event, event.payload.score ? this.computeScore(event.payload) : undefined);
      return;
    }
    if (this.carryover.length < this.carryoverCapacity) {
      this.carryover.push({ event, score: 0 });
    } else {
      this.reject(event, 0, 'CARRYOVER_FULL');
    }
  }

  private drainCarryoverFcfs(): void {
    if (this.carryover.length === 0) return;
    const now = marketClock.now();
    this.carryover = this.carryover.filter((c) => now - c.event.ts <= this.carryoverMaxAgeMs);
    while (this.carryover.length > 0) {
      const head = this.carryover[0];
      const sym = head.event.payload.symbol;
      const exposure = this.riskEngine.getExposure();
      const already = exposure.positions.has(sym) || this.pendingSymbols.has(sym);
      const maxSymbols = Number((this.cfg as any).MAX_OPEN_SYMBOLS) || Infinity;
      const slotsLeft = Math.max(0, maxSymbols - this.effectiveOpenSymbols());
      if (already || slotsLeft > 0) {
        this.carryover.shift();
        if (!already) this.pendingSymbols.add(sym);
        this.forward(head.event, head.event.payload.score ? this.computeScore(head.event.payload) : undefined);
        if (already) continue;
        break;
      }
      break;
    }
  }

  private computeScore(p: OrderRequestedPayload): number {
    if (!p.score) return 0;
    const adxStrength = Math.max(0, p.score.adx - this.adxThreshold) / 10;
    const atrStrength = p.score.atrPct / Math.max(this.minAtrPct, 1e-9);
    return adxStrength * atrStrength;
  }

  private flushBucket(closeTime: number): void {
    const candidates = this.buckets.get(closeTime) ?? [];
    this.buckets.delete(closeTime);
    this.flushTimers.delete(closeTime);

    // M-18: prepend any carryover from the previous bar that's still within
    // age budget — they were already deemed ready-to-trade once; if a slot
    // opened up since, they should claim it before fresh candidates lose
    // their slot. Carryover events keep their original score (and original
    // bus event id, so dedup downstream still works).
    const now = marketClock.now();
    const liveCarryover = this.carryover.filter(
      (c) => now - c.event.ts <= this.carryoverMaxAgeMs,
    );
    this.carryover = []; // consumed
    const merged = [...liveCarryover, ...candidates];
    if (merged.length === 0) return;

    merged.sort((a, b) => b.score - a.score);

    const exposure = this.riskEngine.getExposure();
    const maxSymbols = Number((this.cfg as any).MAX_OPEN_SYMBOLS) || Infinity;
    const slotsLeft = Math.max(0, maxSymbols - exposure.symbols);

    let allocated = 0;
    const newCarryover: BufferedCandidate[] = [];
    for (const c of merged) {
      const already = exposure.positions.has(c.event.payload.symbol);
      if (allocated < slotsLeft || already) {
        this.forward(c.event, c.score);
        if (!already) allocated += 1;
      } else if (newCarryover.length < this.carryoverCapacity) {
        // Park as carryover — it may get a slot at the next flush.
        newCarryover.push(c);
      } else {
        // Carryover is full → reject definitively.
        this.reject(c.event, c.score);
      }
    }
    this.carryover = newCarryover;
  }

  private forward(event: DomainEvent<OrderRequestedPayload>, score?: number): void {
    this.seq += 1;
    this.eventBus.publish({
      ...event,
      id: `alloc-${event.id}-${this.seq}`,
      type: 'execution.order.requested.allocated',
      ts: marketClock.now(),
      source: 'signal-allocator',
      payload: { ...event.payload, score: event.payload.score, ...(score !== undefined ? { allocatorScore: score } : {}) } as OrderRequestedPayload,
    });
  }

  private reject(event: DomainEvent<OrderRequestedPayload>, score: number, reason: string = 'WORSE_THAN_TOP_CANDIDATES'): void {
    this.seq += 1;
    this.eventBus.publish({
      id: `alloc-rej-${event.id}-${this.seq}`,
      type: 'execution.order.rejected',
      ts: marketClock.now(),
      source: 'signal-allocator',
      symbol: event.payload.symbol,
      payload: {
        reason,
        requested: event.payload,
        score,
      },
    });
  }
}
