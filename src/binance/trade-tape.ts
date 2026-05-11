export interface AggTradeEntry {
  price: number;
  qty: number;
  ts: number;
  /** True when buyer is the market maker (sell-aggressor). */
  makerSide: boolean;
}

export class AggTradeTape {
  private buf: AggTradeEntry[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity = 1000) {
    this.buf = new Array(capacity);
  }

  push(t: AggTradeEntry): void {
    this.buf[this.head] = t;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  lastPrice(): number | null {
    if (this.size === 0) return null;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buf[idx].price;
  }

  /** Trades within the trailing `seconds` (relative to most recent trade ts). */
  recent(seconds: number): AggTradeEntry[] {
    if (this.size === 0) return [];
    const lastTs = this.buf[(this.head - 1 + this.capacity) % this.capacity].ts;
    const cutoff = lastTs - seconds * 1000;
    const out: AggTradeEntry[] = [];
    for (let i = 0; i < this.size; i += 1) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const e = this.buf[idx];
      if (e.ts < cutoff) break;
      out.push(e);
    }
    return out.reverse();
  }

  volumeOver(seconds: number): number {
    let v = 0;
    for (const t of this.recent(seconds)) v += t.qty;
    return v;
  }

  vwapOver(seconds: number): number | null {
    let pv = 0;
    let v = 0;
    for (const t of this.recent(seconds)) {
      pv += t.price * t.qty;
      v += t.qty;
    }
    if (v === 0) return null;
    return pv / v;
  }

  count(): number {
    return this.size;
  }
}
