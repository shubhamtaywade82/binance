export interface PriceLevel {
  price: number;
  qty: number;
}

import type { DepthSnapshot } from './rest-depth';

export type { DepthSnapshot };

export interface DepthDiff {
  /** First update id in event. */
  U: number;
  /** Final update id in event. */
  u: number;
  bids: Array<[string | number, string | number]>;
  asks: Array<[string | number, string | number]>;
  /** Optional `pu` (USDM): previous final update id; for futures syncing. */
  pu?: number;
  /** Optional event time. */
  E?: number;
  /** Optional symbol. */
  s?: string;
}

export type DesyncCallback = (info: { reason: string; lastU: number; gotU: number; gotUFirst: number }) => void;

function parseSide(rows: Array<[string | number, string | number]>): Map<number, number> {
  const m = new Map<number, number>();
  for (const [p, q] of rows) {
    const price = Number(p);
    const qty = Number(q);
    if (!Number.isFinite(price)) continue;
    if (qty === 0) m.delete(price);
    else m.set(price, qty);
  }
  return m;
}

function applySide(side: Map<number, number>, rows: Array<[string | number, string | number]>): void {
  for (const [p, q] of rows) {
    const price = Number(p);
    const qty = Number(q);
    if (!Number.isFinite(price)) continue;
    if (qty === 0) side.delete(price);
    else side.set(price, qty);
  }
}

export class LocalOrderBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private lastUpdateId = -1;
  private booted = false;
  private buffered: DepthDiff[] = [];
  private onDesync: DesyncCallback | null = null;

  /** Buffer diffs received before snapshot. */
  buffer(diff: DepthDiff): void {
    if (this.booted) {
      this.applyDiff(diff);
      return;
    }
    this.buffered.push(diff);
  }

  setDesyncHandler(cb: DesyncCallback): void {
    this.onDesync = cb;
  }

  bootstrap(snap: DepthSnapshot): void {
    this.bids = parseSide(snap.bids);
    this.asks = parseSide(snap.asks);
    this.lastUpdateId = snap.lastUpdateId;
    this.booted = true;

    // Per Binance algo: drop any buffered diff with u <= lastUpdateId.
    const pending = this.buffered.filter((d) => d.u > this.lastUpdateId);
    this.buffered = [];
    if (pending.length === 0) return;

    const first = pending[0];
    if (!(first.U <= this.lastUpdateId + 1 && this.lastUpdateId + 1 <= first.u)) {
      this.emitDesync('first_diff_out_of_range', first.U);
      return;
    }
    for (const d of pending) this.applyDiff(d);
  }

  applyDiff(diff: DepthDiff): boolean {
    if (!this.booted) {
      this.buffered.push(diff);
      return false;
    }
    if (diff.u <= this.lastUpdateId) return false;
    if (this.lastUpdateId >= 0 && this.lastUpdateId !== Number.NEGATIVE_INFINITY) {
      // After bootstrap, subsequent events must satisfy U === lastUpdateId + 1
      if (diff.U !== this.lastUpdateId + 1 && !(diff.U <= this.lastUpdateId + 1 && this.lastUpdateId + 1 <= diff.u)) {
        this.emitDesync('gap', diff.U);
        return false;
      }
    }
    applySide(this.bids, diff.bids);
    applySide(this.asks, diff.asks);
    this.lastUpdateId = diff.u;
    return true;
  }

  /** Replace top levels from a partial-depth stream payload (`@depth5/10/20`). */
  replaceFromPartial(snap: { bids: Array<[string | number, string | number]>; asks: Array<[string | number, string | number]> }): void {
    this.bids = parseSide(snap.bids);
    this.asks = parseSide(snap.asks);
    this.booted = true;
  }

  bestBid(): PriceLevel | null {
    let best: PriceLevel | null = null;
    for (const [p, q] of this.bids) {
      if (!best || p > best.price) best = { price: p, qty: q };
    }
    return best;
  }

  bestAsk(): PriceLevel | null {
    let best: PriceLevel | null = null;
    for (const [p, q] of this.asks) {
      if (!best || p < best.price) best = { price: p, qty: q };
    }
    return best;
  }

  spread(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return null;
    return a.price - b.price;
  }

  midPrice(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return null;
    return (a.price + b.price) / 2;
  }

  topLevels(n: number): { bids: PriceLevel[]; asks: PriceLevel[] } {
    const bids = [...this.bids.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => b.price - a.price)
      .slice(0, n);
    const asks = [...this.asks.entries()]
      .map(([price, qty]) => ({ price, qty }))
      .sort((a, b) => a.price - b.price)
      .slice(0, n);
    return { bids, asks };
  }

  isBootstrapped(): boolean {
    return this.booted;
  }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.lastUpdateId = -1;
    this.booted = false;
    this.buffered = [];
  }

  private emitDesync(reason: string, gotUFirst: number): void {
    this.booted = false;
    this.onDesync?.({ reason, lastU: this.lastUpdateId, gotU: gotUFirst, gotUFirst });
  }
}
