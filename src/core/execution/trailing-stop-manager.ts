import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';

interface OpenPosition {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  quantity: number;
  highWater: number;
  lowWater: number;
  initialStop: number;
  atr: number;
  atrMult: number;
  partialDone?: boolean;
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
  /** R-multiple at which to book a partial profit (e.g. 1.0). 0 to disable. */
  partialTpR?: number;
  /** Fraction of position to close at partialTpR (e.g. 0.5). */
  partialTpPct?: number;
  /** Enable SMC structure-break (CHoCH) exit. */
  smcExitEnabled?: boolean;
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
 *   market.kline.closed                 → tick trail + check breach + SMC exit
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
    this.eventBus.subscribe('market.bookticker', (e: DomainEvent<any>) => this.onBookTicker(e));
  }

  private onFilled(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol: string | undefined = p.symbol;
    if (!symbol) return;
    
    const fillPrice = Number(p.price) || 0;
    const fillQty = Number(p.quantity) || 0;
    if (fillPrice <= 0 || fillQty <= 0) return;

    const existing = this.positions.get(symbol);
    if (existing) {
      // PYRAMIDING: Update quantity and average entry price
      const newQty = existing.quantity + fillQty;
      const newEntry = (existing.entry * existing.quantity + fillPrice * fillQty) / newQty;
      existing.entry = newEntry;
      existing.quantity = newQty;
      // We don't reset highWater/lowWater or ATR/stop on pyramid adds.
      return;
    }

    const side: 'LONG' | 'SHORT' = p.side === 'SHORT' ? 'SHORT' : 'LONG';
    const stop = Number(p.stopLoss) || (side === 'LONG'
      ? fillPrice * (1 - this.opts.defaultAtrPct * this.opts.atrMult)
      : fillPrice * (1 + this.opts.defaultAtrPct * this.opts.atrMult));
    const atr = Math.abs(fillPrice - stop) / this.opts.atrMult || fillPrice * this.opts.defaultAtrPct;

    this.positions.set(symbol, {
      orderId: String(p.orderId ?? ''),
      symbol,
      side,
      entry: fillPrice,
      quantity: fillQty,
      highWater: fillPrice,
      lowWater: fillPrice,
      initialStop: stop,
      atr,
      atrMult: this.opts.atrMult,
      partialDone: false,
    });
  }

  private onClosed(event: DomainEvent<any>): void {
    const sym: string | undefined = event.payload?.symbol;
    if (!sym) return;
    
    const pos = this.positions.get(sym);
    if (!pos) return;

    if (event.payload?.reason === 'PARTIAL_TP') {
      const closedQty = Number(event.payload.quantity) || 0;
      pos.quantity -= closedQty;
      pos.partialDone = true;
      if (pos.quantity <= 0) this.positions.delete(sym);
      return;
    }

    this.positions.delete(sym);
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

    // 1. Check SMC Exit (only on kline close)
    if (this.opts.smcExitEnabled && event.payload?.smc) {
      const smc = event.payload.smc;
      if (pos.side === 'LONG' && (smc.choch === 'BEARISH' || smc.trend === 'bearish')) {
        this.requestClose(pos, close, 'SMC_EXIT', 'kline');
        return;
      }
      if (pos.side === 'SHORT' && (smc.choch === 'BULLISH' || smc.trend === 'bullish')) {
        this.requestClose(pos, close, 'SMC_EXIT', 'kline');
        return;
      }
    }

    this.update(pos, high, low, close, 'kline');
  }

  private onBookTicker(event: DomainEvent<any>): void {
    const sym: string | undefined = event.symbol;
    if (!sym) return;
    const pos = this.positions.get(sym);
    if (!pos) return;

    const mid = (Number(event.payload?.bestBidPrice) + Number(event.payload?.bestAskPrice)) / 2;
    if (!Number.isFinite(mid)) return;

    if (this.opts.klineOnly) {
      if (pos.side === 'LONG' && mid > pos.highWater) pos.highWater = mid;
      if (pos.side === 'SHORT' && mid < pos.lowWater) pos.lowWater = mid;
      return;
    }

    this.update(pos, mid, mid, mid, 'bookticker');
  }

  private update(pos: OpenPosition, high: number, low: number, ref: number, source: string): void {
    let trail: number;
    const atrDist = pos.atrMult * pos.atr;

    if (pos.side === 'LONG') {
      if (Number.isFinite(high) && high > pos.highWater) pos.highWater = high;
      
      // Partial TP Check
      if (this.opts.partialTpR && !pos.partialDone) {
        const target = pos.entry + this.opts.partialTpR * pos.atr;
        if (ref >= target) {
          this.requestPartialClose(pos, ref, 'PARTIAL_TP', source);
        }
      }

      trail = Math.max(pos.initialStop, pos.highWater - atrDist);
      this.emitTrailUpdate(pos, trail);
      if (ref <= trail) this.requestClose(pos, ref, 'TRAIL', source);
    } else {
      if (Number.isFinite(low) && low < pos.lowWater) pos.lowWater = low;

      // Partial TP Check
      if (this.opts.partialTpR && !pos.partialDone) {
        const target = pos.entry - this.opts.partialTpR * pos.atr;
        if (ref <= target) {
          this.requestPartialClose(pos, ref, 'PARTIAL_TP', source);
        }
      }

      trail = Math.min(pos.initialStop, pos.lowWater + atrDist);
      this.emitTrailUpdate(pos, trail);
      if (ref >= trail) this.requestClose(pos, ref, 'TRAIL', source);
    }
  }

  private lastTrailEmit = new Map<string, number>();
  private emitTrailUpdate(pos: OpenPosition, trail: number): void {
    const now = marketClock.now();
    const last = this.lastTrailEmit.get(pos.symbol) ?? 0;
    if (now - last < 1000) return;
    this.lastTrailEmit.set(pos.symbol, now);
    this.seq += 1;
    this.eventBus.publish({
      id: `trail-${pos.symbol}-${now}-${this.seq}`,
      type: 'trail.update',
      ts: now,
      source: 'trailing-stop-manager',
      symbol: pos.symbol,
      payload: {
        orderId: pos.orderId,
        symbol: pos.symbol,
        side: pos.side,
        entry: pos.entry,
        initialStop: pos.initialStop,
        currentTrail: trail,
        highWater: pos.highWater,
        lowWater: pos.lowWater,
        atr: pos.atr,
        atrMult: pos.atrMult,
      },
    });
  }

  private requestClose(pos: OpenPosition, price: number, reason: string, source: string): void {
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

  private requestPartialClose(pos: OpenPosition, price: number, reason: string, source: string): void {
    this.seq += 1;
    const ts = marketClock.now();
    const qtyToClose = pos.quantity * (this.opts.partialTpPct ?? 0.5);
    
    this.eventBus.publish({
      id: `partial-close-req-${pos.symbol}-${ts}-${this.seq}`,
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
        quantity: qtyToClose,
      },
    });
  }
}
