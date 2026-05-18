import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
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

export interface StructureExitOptions {
  /** Bars to scan for swing pivots. Wider = looser exit. */
  swingLookback: number;
  /** Bars to retain in the per-symbol buffer. Must be ≥ 3×swingLookback for stable pivots. */
  bufferBars: number;
}

const DEFAULTS: StructureExitOptions = { swingLookback: 5, bufferBars: 60 };

/**
 * StructureExitManager — closes positions when market structure breaks
 * against the trade.
 *
 *   LONG :  close when bar closes below the most recent swing low formed
 *           BEFORE / AT entry (the "invalidation level" of the entry idea).
 *   SHORT:  close when bar closes above the most recent swing high.
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
 *
 * Publishes:
 *   execution.position.close.requested  reason=SMC_EXIT
 */
export class StructureExitManager {
  private positions = new Map<string, TrackedPosition>();
  private buffers = new Map<string, Candle[]>();
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

    if (pos.side === 'LONG' && close < pos.invalidationLevel) {
      this.requestClose(pos, close);
    } else if (pos.side === 'SHORT' && close > pos.invalidationLevel) {
      this.requestClose(pos, close);
    }
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
