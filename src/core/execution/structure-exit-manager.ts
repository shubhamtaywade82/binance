import { EventBus } from '../events/event-bus';
import { DomainEvent, SignalPayload } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';
import { swingHighsLows } from '../../strategy/indicators';
import type { Candle } from '../../types';

interface TrackedPosition {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  /** Most recent confirmed swing-low (LONG) / swing-high (SHORT) below/above entry. */
  invalidationLevel: number | null;
}

interface CachedSignal {
  direction: 'LONG' | 'SHORT';
  confidence: number;
  ts: number;
}

export interface StructureExitOptions {
  /** Bars to scan for swing pivots. Wider = looser exit. */
  swingLookback: number;
  /** Bars to retain in the per-symbol buffer. Must be ≥ 3×swingLookback for stable pivots. */
  bufferBars: number;
  /**
   * When true, gate the SMC_EXIT on signal confirmation. If the latest
   * strategy signal still agrees with the position direction AND the
   * position is profitable, the structure exit is skipped. Default true.
   */
  checkSignals: boolean;
}

const DEFAULTS: StructureExitOptions = { swingLookback: 5, bufferBars: 60, checkSignals: true };

/**
 * StructureExitManager — closes positions when market structure breaks
 * against the trade.
 *
 *   LONG :  close when bar closes below the most recent swing low formed
 *           BEFORE / AT entry (the "invalidation level" of the entry idea).
 *   SHORT:  close when bar closes above the most recent swing high.
 *
 * Signal gating (when `checkSignals` is true):
 *   Before issuing SMC_EXIT, checks the most recent strategy.signal for the
 *   same symbol. If the signal still agrees with the position direction AND
 *   the position is currently profitable (close vs entry), the exit is
 *   suppressed — the trend structure may have broken locally but the broader
 *   signal confluence still favors the trade. This prevents premature exits
 *   during healthy pullbacks in a strong trend.
 *
 * Distinct from the trailing stop — the trail follows price; the structure
 * exit fires earlier when the bullish/bearish structure that justified the
 * entry is broken, even if price hasn't reached the trail yet. Pairs well
 * with Seykota: the trail catches drift exits, the structure exit catches
 * trend-failure exits.
 *
 * Subscribes:
 *   execution.order.filled           → register + lock the invalidation level
 *   execution.position.closed        → drop
 *   market.kline.closed (LTF only)   → recompute swings, check break
 *   strategy.signal                  → cache latest signal for gating
 *
 * Publishes:
 *   execution.position.close.requested  reason=SMC_EXIT
 */
export class StructureExitManager {
  private positions = new Map<string, TrackedPosition>();
  private buffers = new Map<string, Candle[]>();
  private signals = new Map<string, CachedSignal>();
  private seq = 0;
  private readonly opts: StructureExitOptions;

  constructor(private readonly eventBus: EventBus, opts: Partial<StructureExitOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.subscribe();
  }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => this.onFilled(e));
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => this.onClosed(e));
    this.eventBus.subscribe('market.kline.closed', (e: DomainEvent<any>) => this.onKline(e));
    if (this.opts.checkSignals) {
      this.eventBus.subscribe<SignalPayload>('strategy.signal', (e: DomainEvent<SignalPayload>) => {
        this.onSignal(e);
      });
    }
  }

  private onSignal(event: DomainEvent<SignalPayload>): void {
    const symbol = event.symbol;
    if (!symbol) return;
    const sig = event.payload;
    const direction = sig.signal === 'LONG' ? 'LONG' : sig.signal === 'SHORT' ? 'SHORT' : null;
    if (!direction) return;
    this.signals.set(symbol, {
      direction,
      confidence: sig.confidence ?? 0,
      ts: event.ts,
    });
  }

  private onFilled(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol: string | undefined = p?.symbol;
    if (!symbol) return;
    if (this.positions.has(symbol)) return; // first fill only
    const side: 'LONG' | 'SHORT' = p?.side === 'SHORT' ? 'SHORT' : 'LONG';
    const entry = Number(p?.price) || 0;
    if (entry <= 0) return;

    const buf = this.buffers.get(symbol) ?? [];
    const level = this.computeInvalidationLevel(side, buf, entry);
    this.positions.set(symbol, { orderId: String(p?.orderId ?? ''), symbol, side, entry, invalidationLevel: level });
  }

  private onClosed(event: DomainEvent<any>): void {
    const sym = event.payload?.symbol;
    if (event.payload?.reason === 'PARTIAL_TP') return;
    if (sym) this.positions.delete(sym);
  }

  private onKline(event: DomainEvent<any>): void {
    const symbol = event.symbol;
    if (!symbol) return;
    const close = Number(event.payload?.close);
    const high = Number(event.payload?.high);
    const low = Number(event.payload?.low);
    if (!Number.isFinite(close)) return;

    // Maintain rolling buffer per symbol
    const buf = this.buffers.get(symbol) ?? [];
    buf.push({
      openTime: Number(event.payload?.openTime) || event.ts,
      closeTime: Number(event.payload?.closeTime) || event.ts,
      open: Number(event.payload?.open) || close,
      high: Number.isFinite(high) ? high : close,
      low: Number.isFinite(low) ? low : close,
      close,
      volume: Number(event.payload?.volume) || 0,
    });
    if (buf.length > this.opts.bufferBars) buf.splice(0, buf.length - this.opts.bufferBars);
    this.buffers.set(symbol, buf);

    const pos = this.positions.get(symbol);
    if (!pos || pos.invalidationLevel == null) return;

    const structureBroken =
      (pos.side === 'LONG' && close < pos.invalidationLevel) ||
      (pos.side === 'SHORT' && close > pos.invalidationLevel);

    if (!structureBroken) return;

    // Signal gating: if the latest strategy signal still agrees with the
    // position direction AND the position is currently profitable, suppress
    // the structure exit — the broader trend is intact despite the local break.
    if (this.opts.checkSignals) {
      const sig = this.signals.get(symbol);
      const isProfitable = pos.side === 'LONG' ? close > pos.entry : close < pos.entry;
      if (sig && sig.direction === pos.side && isProfitable) {
        // Signal still agrees + position is green → skip structure exit
        return;
      }
    }

    this.requestClose(pos, close);
  }

  private computeInvalidationLevel(side: 'LONG' | 'SHORT', buf: Candle[], entry: number): number | null {
    if (buf.length < this.opts.swingLookback * 2 + 1) return null;
    const swings = swingHighsLows(buf, this.opts.swingLookback);
    if (side === 'LONG') {
      // Most recent swing low BELOW entry
      const lows = swings.lows.filter((s) => s.price < entry).sort((a, b) => b.index - a.index);
      return lows[0]?.price ?? null;
    }
    const highs = swings.highs.filter((s) => s.price > entry).sort((a, b) => b.index - a.index);
    return highs[0]?.price ?? null;
  }

  private requestClose(pos: TrackedPosition, price: number): void {
    this.positions.delete(pos.symbol);
    this.seq += 1;
    const ts = marketClock.now();
    this.eventBus.publish({
      id: `struct-exit-${pos.symbol}-${ts}-${this.seq}`,
      type: 'execution.position.close.requested',
      ts,
      source: 'structure-exit-manager',
      symbol: pos.symbol,
      payload: {
        symbol: pos.symbol,
        orderId: pos.orderId,
        side: pos.side,
        reason: 'SMC_EXIT',
        triggerPrice: price,
        invalidationLevel: pos.invalidationLevel,
      },
    });
  }
}
