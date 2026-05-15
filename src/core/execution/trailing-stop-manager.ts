import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';

interface OpenPosition {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  highWater: number;
  lowWater: number;
  initialStop: number;
  atr: number;
  atrMult: number;
}

export interface TrailingStopOptions {
  /** Multiplier on ATR for the trailing distance. Should match strategy's atrMult. */
  atrMult: number;
  /**
   * Fallback ATR when filled event doesn't carry one (no on-fill ATR plumbing yet).
   * Strategies that want exact behavior should publish atrAtEntry inside the fill payload.
   */
  defaultAtrPct: number;
  /** Close on close-of-bar breach (`kline.closed`). Set false to also react to bookticker. */
  klineOnly: boolean;
}

const DEFAULTS: TrailingStopOptions = { atrMult: 3, defaultAtrPct: 0.005, klineOnly: true };

/**
 * TrailingStopManager — Chandelier-exit style ATR trail.
 *
 *   LONG:  stop = max(entryStop, highWater - atrMult * atr)
 *   SHORT: stop = min(entryStop, lowWater + atrMult * atr)
 *
 * Subscribes:
 *   execution.order.filled              → register new position
 *   execution.position.closed           → drop position
 *   market.kline.closed                 → tick trail + check breach
 *   market.bookticker (optional)        → tighter exit on wicks
 *
 * Publishes:
 *   execution.position.close.requested  → PositionCloseBridge picks it up
 */
export class TrailingStopManager {
  private readonly opts: TrailingStopOptions;
  private positions = new Map<string, OpenPosition>(); // by symbol
  private seq = 0;

  constructor(private readonly eventBus: EventBus, opts: Partial<TrailingStopOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.subscribe();
  }

  public getPositions(): ReadonlyMap<string, OpenPosition> {
    return this.positions;
  }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => this.onFilled(e));
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => this.onClosed(e));
    this.eventBus.subscribe('market.kline.closed', (e: DomainEvent<any>) => this.onKline(e));
    if (!this.opts.klineOnly) {
      this.eventBus.subscribe('market.bookticker', (e: DomainEvent<any>) => this.onBookTicker(e));
    }
  }

  private onFilled(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol: string | undefined = p.symbol;
    if (!symbol) return;
    if (this.positions.has(symbol)) return; // first fill only — pyramiding handled in Phase 2

    const side: 'LONG' | 'SHORT' = p.side === 'SHORT' ? 'SHORT' : 'LONG';
    const entry = Number(p.price) || 0;
    if (entry <= 0) return;

    const stop = Number(p.stopLoss) || (side === 'LONG'
      ? entry * (1 - this.opts.defaultAtrPct * this.opts.atrMult)
      : entry * (1 + this.opts.defaultAtrPct * this.opts.atrMult));
    const atr = Math.abs(entry - stop) / this.opts.atrMult || entry * this.opts.defaultAtrPct;

    this.positions.set(symbol, {
      orderId: String(p.orderId ?? ''),
      symbol,
      side,
      entry,
      highWater: entry,
      lowWater: entry,
      initialStop: stop,
      atr,
      atrMult: this.opts.atrMult,
    });
  }

  private onClosed(event: DomainEvent<any>): void {
    const sym: string | undefined = event.payload?.symbol;
    if (sym) this.positions.delete(sym);
  }

  private onKline(event: DomainEvent<any>): void {
    const sym: string | undefined = event.symbol;
    if (!sym) return;
    const pos = this.positions.get(sym);
    if (!pos) return;
    const close = Number(event.payload?.close);
    const high = Number(event.payload?.high);
    const low = Number(event.payload?.low);
    if (!Number.isFinite(close)) return;
    this.update(pos, high, low, close, 'kline');
  }

  private onBookTicker(event: DomainEvent<any>): void {
    const sym: string | undefined = event.symbol;
    if (!sym) return;
    const pos = this.positions.get(sym);
    if (!pos) return;
    const mid = (Number(event.payload?.bestBidPrice) + Number(event.payload?.bestAskPrice)) / 2;
    if (!Number.isFinite(mid)) return;
    this.update(pos, mid, mid, mid, 'bookticker');
  }

  private update(pos: OpenPosition, high: number, low: number, ref: number, source: string): void {
    if (pos.side === 'LONG') {
      if (Number.isFinite(high) && high > pos.highWater) pos.highWater = high;
      const trail = Math.max(pos.initialStop, pos.highWater - pos.atrMult * pos.atr);
      if (ref <= trail) this.requestClose(pos, ref, 'TRAIL', source);
    } else {
      if (Number.isFinite(low) && low < pos.lowWater) pos.lowWater = low;
      const trail = Math.min(pos.initialStop, pos.lowWater + pos.atrMult * pos.atr);
      if (ref >= trail) this.requestClose(pos, ref, 'TRAIL', source);
    }
  }

  private requestClose(pos: OpenPosition, price: number, reason: string, source: string): void {
    // Remove immediately to avoid double-close on next tick before bridge ack.
    this.positions.delete(pos.symbol);
    this.seq += 1;
    const ts = marketClock.now();
    this.eventBus.publish({
      id: `close-req-${pos.symbol}-${ts}-${this.seq}`,
      type: 'execution.position.close.requested',
      ts,
      source: `trailing-stop:${source}`,
      symbol: pos.symbol,
      payload: {
        symbol: pos.symbol,
        orderId: pos.orderId,
        side: pos.side,
        reason,
        triggerPrice: price,
      },
    });
  }
}
