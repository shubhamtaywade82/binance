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
export class SignalAllocator {
  private buckets = new Map<number, BufferedCandidate[]>();
  private flushTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly flushDelayMs: number;
  private readonly adxThreshold: number;
  private readonly minAtrPct: number;
  private seq = 0;

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly riskEngine: RiskEngine,
    opts: { flushDelayMs?: number } = {},
  ) {
    this.flushDelayMs = opts.flushDelayMs ?? 1500;
    this.adxThreshold = Number((cfg as any).SEYKOTA_ADX_THRESHOLD) || 20;
    this.minAtrPct = Number((cfg as any).SEYKOTA_MIN_ATR_PCT) || 0.003;
    this.subscribe();
  }

  private subscribe(): void {
    this.eventBus.subscribe<OrderRequestedPayload>('execution.order.requested', (e) => {
      this.bufferCandidate(e);
    });
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
    if (candidates.length === 0) return;

    candidates.sort((a, b) => b.score - a.score);

    const exposure = this.riskEngine.getExposure();
    const maxSymbols = Number((this.cfg as any).MAX_OPEN_SYMBOLS) || Infinity;
    const slotsLeft = Math.max(0, maxSymbols - exposure.symbols);

    let allocated = 0;
    for (const c of candidates) {
      const already = exposure.positions.has(c.event.payload.symbol);
      if (allocated < slotsLeft || already) {
        this.forward(c.event, c.score);
        if (!already) allocated += 1;
      } else {
        this.reject(c.event, c.score);
      }
    }
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

  private reject(event: DomainEvent<OrderRequestedPayload>, score: number): void {
    this.seq += 1;
    this.eventBus.publish({
      id: `alloc-rej-${event.id}-${this.seq}`,
      type: 'execution.order.rejected',
      ts: marketClock.now(),
      source: 'signal-allocator',
      symbol: event.payload.symbol,
      payload: {
        reason: 'WORSE_THAN_TOP_CANDIDATES',
        requested: event.payload,
        score,
      },
    });
  }
}
