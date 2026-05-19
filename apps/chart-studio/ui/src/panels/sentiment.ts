import type { Trade } from '../provider-client';

/**
 * Rolling order-flow imbalance over the last N seconds.
 */
export class SentimentPanel {
  private readonly windowMs = 60_000;
  private trades: Trade[] = [];

  constructor(private readonly root: HTMLElement) {
    this.render(0.5, 0, 0);
  }

  push(t: Trade): void {
    this.trades.push(t);
    const cutoff = Date.now() - this.windowMs;
    while (this.trades.length > 0 && this.trades[0]!.ts < cutoff) this.trades.shift();
    let buy = 0;
    let sell = 0;
    for (const tr of this.trades) {
      if (tr.makerSide) sell += tr.qty;
      else buy += tr.qty;
    }
    const total = buy + sell;
    const ratio = total > 0 ? buy / total : 0.5;
    this.render(ratio, buy, sell);
  }

  reset(): void {
    this.trades = [];
    this.render(0.5, 0, 0);
  }

  private render(ratio: number, buy: number, sell: number): void {
    const left = Math.max(0, 0.5 - ratio) * 100; // sell pushes left of midpoint
    const right = Math.max(0, ratio - 0.5) * 100;
    this.root.innerHTML = `
      <div class="label"><span>Sell ${sell.toFixed(2)}</span><span>${(ratio * 100).toFixed(1)}%</span><span>Buy ${buy.toFixed(2)}</span></div>
      <div class="bar">
        <div class="fill sell" style="left: ${50 - left}%; width: ${left}%;"></div>
        <div class="fill buy" style="left: 50%; width: ${right}%;"></div>
      </div>
    `;
  }
}
