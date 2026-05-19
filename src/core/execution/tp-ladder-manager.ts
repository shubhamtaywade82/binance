import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';

interface LadderRung {
  price: number;
  /** Fraction of ORIGINAL fill qty. */
  fraction: number;
  pricePct?: number;
  hit: boolean;
}

interface Tracked {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  originalQty: number;
  remainingQty: number;
  rungs: LadderRung[];
  /** When all rungs cleared, manager publishes a synthetic close.requested
   *  for the remainder UNLESS trailAfterLadder=true (then TrailingStopManager
   *  is expected to take over). */
  trailAfterLadder: boolean;
}

export interface TpLadderOptions {
  /** Also react to bookticker mid-price (not only kline close). */
  intrabar: boolean;
  /**
   * Round-trip fee buffer (fraction of entry price). Each rung's hit price
   * is pushed outward by this amount before comparison so a rung fires only
   * when the trader nets the rung's target after fees. Default 0 keeps the
   * legacy gross-target behavior.
   */
  feeBufferPct?: number;
}

const DEFAULTS: TpLadderOptions = { intrabar: true };

/**
 * TpLadderManager — executes the staged take-profit ladder attached to an
 * order's fill payload.
 *
 * AdaptiveStrategy puts a `tpLadder: [{price, fraction}, ...]` array on the
 * OrderRequestedPayload. ExecutionBridge currently doesn't strip extra
 * fields, so it flows through to execution.order.filled. On fill we
 * register the ladder; on each kline/bookticker we check whether the next
 * rung's price has been hit and emit a partial close request.
 *
 * Distinct from the trailing manager: the ladder fires at FIXED price
 * targets (your 5/10/15/20% spec); the trail manages the runner.
 */
export class TpLadderManager {
  private positions = new Map<string, Tracked>();
  private seq = 0;
  private readonly opts: TpLadderOptions;

  constructor(private readonly eventBus: EventBus, opts: Partial<TpLadderOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.subscribe();
  }

  public getTracked(): ReadonlyMap<string, Tracked> { return this.positions; }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => this.onFilled(e));
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => this.onClosed(e));
    this.eventBus.subscribe('market.kline.closed', (e: DomainEvent<any>) => this.onKline(e));
    if (this.opts.intrabar) {
      this.eventBus.subscribe('market.bookticker', (e: DomainEvent<any>) => this.onBookTicker(e));
    }
  }

  private onFilled(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol: string | undefined = p?.symbol;
    if (!symbol) return;
    if (this.positions.has(symbol)) return; // first fill only
    const ladder = (p as any).tpLadder;
    if (!Array.isArray(ladder) || ladder.length === 0) return;
    const side: 'LONG' | 'SHORT' = p?.side === 'SHORT' ? 'SHORT' : 'LONG';
    const qty = Number(p?.quantity) || 0;
    if (qty <= 0) return;

    const entry = Number(p?.price) || 0;
    if (entry <= 0) return;
    this.positions.set(symbol, {
      orderId: String(p?.orderId ?? ''),
      symbol,
      side,
      entry,
      originalQty: qty,
      remainingQty: qty,
      rungs: ladder
        .filter((r: any) => Number.isFinite(Number(r?.price)) && Number(r?.fraction) > 0)
        .map((r: any) => ({
          price: Number(r.price),
          fraction: Number(r.fraction),
          pricePct: Number(r.pricePct),
          hit: false,
        })),
      trailAfterLadder: Boolean((p as any).trailAfterLadder),
    });
  }

  private onClosed(event: DomainEvent<any>): void {
    const sym = event.payload?.symbol;
    if (!sym) return;
    if (event.payload?.reason === 'PARTIAL_TP') {
      // Track remaining quantity decrement.
      const t = this.positions.get(sym);
      if (t) {
        const qty = Number(event.payload?.quantity) || 0;
        t.remainingQty = Math.max(0, t.remainingQty - qty);
        if (t.remainingQty <= 1e-12) this.positions.delete(sym);
      }
      return;
    }
    this.positions.delete(sym);
  }

  private onKline(event: DomainEvent<any>): void {
    const sym = event.symbol;
    if (!sym) return;
    const t = this.positions.get(sym);
    if (!t) return;
    const close = Number(event.payload?.close);
    if (Number.isFinite(close)) this.checkRungs(t, close, 'kline');
  }

  private onBookTicker(event: DomainEvent<any>): void {
    const sym = event.symbol;
    if (!sym) return;
    const t = this.positions.get(sym);
    if (!t) return;
    const bid = Number(event.payload?.bestBidPrice);
    const ask = Number(event.payload?.bestAskPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
    const mid = (bid + ask) / 2;
    this.checkRungs(t, mid, 'bookticker');
  }

  private checkRungs(t: Tracked, ref: number, source: string): void {
    // Push each rung's trigger price outward by the round-trip fee buffer so
    // a rung fires only when the trader nets the configured target after
    // fees. LONG needs a higher price, SHORT a lower price.
    const feeBuf = this.opts.feeBufferPct ?? 0;
    const dir = t.side === 'LONG' ? 1 : -1;
    const buffer = t.entry * feeBuf;
    for (const r of t.rungs) {
      if (r.hit) continue;
      const adjusted = r.price + dir * buffer;
      const hit = t.side === 'LONG' ? ref >= adjusted : ref <= adjusted;
      if (!hit) continue;
      r.hit = true;
      this.firePartial(t, r, ref, source);
    }

    // If all rungs done and trailAfterLadder is false → close residual.
    const remainingRungs = t.rungs.some((r) => !r.hit);
    if (!remainingRungs && t.remainingQty > 1e-12 && !t.trailAfterLadder) {
      this.fireFinal(t, ref, source);
    }
  }

  private firePartial(t: Tracked, rung: LadderRung, ref: number, source: string): void {
    this.seq += 1;
    const qty = t.originalQty * rung.fraction;
    const ts = marketClock.now();
    this.eventBus.publish({
      id: `tp-rung-${t.symbol}-${ts}-${this.seq}`,
      type: 'execution.position.close.requested',
      ts,
      source: `tp-ladder:${source}`,
      symbol: t.symbol,
      payload: {
        symbol: t.symbol,
        orderId: t.orderId,
        side: t.side,
        reason: 'PARTIAL_TP',
        triggerPrice: ref,
        quantity: qty,
        rungPct: rung.pricePct,
      },
    });
  }

  private fireFinal(t: Tracked, ref: number, source: string): void {
    this.positions.delete(t.symbol);
    this.seq += 1;
    const ts = marketClock.now();
    this.eventBus.publish({
      id: `tp-final-${t.symbol}-${ts}-${this.seq}`,
      type: 'execution.position.close.requested',
      ts,
      source: `tp-ladder:${source}`,
      symbol: t.symbol,
      payload: {
        symbol: t.symbol,
        orderId: t.orderId,
        side: t.side,
        reason: 'TP',
        triggerPrice: ref,
      },
    });
  }
}
