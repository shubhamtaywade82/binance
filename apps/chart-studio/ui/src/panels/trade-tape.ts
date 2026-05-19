import type { Trade } from '../provider-client';

export class TradeTapePanel {
  private rows: Trade[] = [];
  private capacity = 80;

  constructor(private readonly root: HTMLElement) {}

  push(t: Trade): void {
    this.rows.unshift(t);
    if (this.rows.length > this.capacity) this.rows.length = this.capacity;
    this.render();
  }

  reset(): void {
    this.rows = [];
    this.root.innerHTML = '';
  }

  private render(): void {
    const fmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    this.root.innerHTML = this.rows.map((t) => {
      const side = t.makerSide ? 'sell' : 'buy';
      const px = t.price.toLocaleString(undefined, { maximumFractionDigits: 6 });
      const qty = t.qty.toLocaleString(undefined, { maximumFractionDigits: 4 });
      return `<div class="row"><span class="px ${side}">${px}</span><span class="qty">${qty}</span><span class="ts">${fmt.format(new Date(t.ts))}</span></div>`;
    }).join('');
  }
}
