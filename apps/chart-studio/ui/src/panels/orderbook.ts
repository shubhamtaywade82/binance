import type { DepthDelta, OrderBookSnapshot } from '../provider-client';

interface Level { price: number; qty: number }

const sortDesc = (a: Level, b: Level): number => b.price - a.price;
const sortAsc = (a: Level, b: Level): number => a.price - b.price;

export class OrderBookPanel {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private depth = 12;

  constructor(private readonly root: HTMLElement, private readonly spreadEl: HTMLElement) {}

  reset(snapshot: OrderBookSnapshot): void {
    this.bids.clear();
    this.asks.clear();
    for (const [p, q] of snapshot.bids) if (q > 0) this.bids.set(p, q);
    for (const [p, q] of snapshot.asks) if (q > 0) this.asks.set(p, q);
    this.render();
  }

  applyDelta(delta: DepthDelta): void {
    if (delta.replacement) {
      // Provider sent a full top-N snapshot, replace bids/asks with these levels.
      this.bids.clear();
      this.asks.clear();
      for (const [p, q] of delta.bids) if (q > 0 && p > 0) this.bids.set(p, q);
      for (const [p, q] of delta.asks) if (q > 0 && p > 0) this.asks.set(p, q);
    } else {
      for (const [p, q] of delta.bids) {
        if (q === 0) this.bids.delete(p);
        else this.bids.set(p, q);
      }
      for (const [p, q] of delta.asks) {
        if (q === 0) this.asks.delete(p);
        else this.asks.set(p, q);
      }
    }
    this.render();
  }

  private topLevels(map: Map<number, number>, n: number, cmp: (a: Level, b: Level) => number): Level[] {
    const arr: Level[] = [];
    for (const [price, qty] of map) arr.push({ price, qty });
    arr.sort(cmp);
    return arr.slice(0, n);
  }

  private render(): void {
    const askRows = this.topLevels(this.asks, this.depth, sortAsc).reverse();
    const bidRows = this.topLevels(this.bids, this.depth, sortDesc);

    const fmtPx = (n: number): string => n.toFixed(this.estimateDecimals());
    const fmtQty = (n: number): string => n.toLocaleString(undefined, { maximumFractionDigits: 3 });

    let askTotal = 0;
    const asksHtml = askRows.map((l) => {
      askTotal += l.qty;
      return `<div class="row ask"><span class="qty">${fmtQty(l.qty)}</span><span class="px">${fmtPx(l.price)}</span><span class="total">${fmtQty(askTotal)}</span></div>`;
    }).join('');

    let bidTotal = 0;
    const bidsHtml = bidRows.map((l) => {
      bidTotal += l.qty;
      return `<div class="row bid"><span class="qty">${fmtQty(l.qty)}</span><span class="px">${fmtPx(l.price)}</span><span class="total">${fmtQty(bidTotal)}</span></div>`;
    }).join('');

    const bestBid = bidRows[0]?.price;
    const bestAsk = askRows[askRows.length - 1]?.price;
    if (bestBid !== undefined && bestAsk !== undefined && bestAsk >= bestBid) {
      const spread = bestAsk - bestBid;
      const mid = (bestAsk + bestBid) / 2;
      this.spreadEl.textContent = `${fmtPx(spread)} (${((spread / mid) * 10_000).toFixed(2)} bps)`;
    } else {
      this.spreadEl.textContent = '';
    }

    this.root.innerHTML = `${asksHtml}<div class="spread">— mid ${bestAsk !== undefined && bestBid !== undefined ? fmtPx((bestAsk + bestBid) / 2) : '—'} —</div>${bidsHtml}`;
  }

  private estimateDecimals(): number {
    const sample = this.bids.keys().next().value ?? this.asks.keys().next().value;
    if (typeof sample !== 'number') return 2;
    if (sample >= 1000) return 2;
    if (sample >= 1) return 3;
    if (sample >= 0.01) return 4;
    return 6;
  }
}
