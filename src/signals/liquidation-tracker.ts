import type { ForceOrderEvent } from '../binance/ws-multiplex';

interface LiquidationEntry {
  ts: number;
  symbol: string;
  side: string;
  qty: number;
  notional: number;
}

export class LiquidationCascadeTracker {
  private buf: LiquidationEntry[];
  private head = 0;
  private size = 0;

  constructor(private readonly capacity = 500) {
    this.buf = new Array(capacity);
  }

  push(event: ForceOrderEvent): void {
    const qty = parseFloat(event.filledAccumulatedQty) || parseFloat(event.origQty) || 0;
    const price = parseFloat(event.avgPrice) || parseFloat(event.price) || 0;
    this.buf[this.head] = {
      ts: event.tradeTime,
      symbol: event.symbol,
      side: event.side,
      qty,
      notional: qty * price,
    };
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  private recentEntries(windowMs: number): LiquidationEntry[] {
    if (this.size === 0) return [];
    const latest = this.buf[(this.head - 1 + this.capacity) % this.capacity];
    const cutoff = latest.ts - windowMs;
    const out: LiquidationEntry[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const e = this.buf[idx];
      if (e.ts < cutoff) break;
      out.push(e);
    }
    return out;
  }

  rollingForcedVolume(windowSec: number): number {
    let total = 0;
    for (const e of this.recentEntries(windowSec * 1000)) total += e.notional;
    return total;
  }

  rollingForcedCount(windowSec: number): number {
    return this.recentEntries(windowSec * 1000).length;
  }

  /**
   * Net liquidation side bias: positive = more longs liquidated (bearish pressure),
   * negative = more shorts liquidated (bullish pressure).
   */
  sideBias(windowSec: number): number {
    let longVol = 0;
    let shortVol = 0;
    for (const e of this.recentEntries(windowSec * 1000)) {
      if (e.side === 'SELL') longVol += e.notional;
      else shortVol += e.notional;
    }
    const total = longVol + shortVol;
    if (total === 0) return 0;
    return (longVol - shortVol) / total;
  }

  cascadeActive(windowSec: number, thresholdNotional: number): boolean {
    return this.rollingForcedVolume(windowSec) >= thresholdNotional;
  }

  snapshot(windowSec = 30): LiquidationSnapshot {
    return {
      volume30s: this.rollingForcedVolume(windowSec),
      count30s: this.rollingForcedCount(windowSec),
      sideBias30s: this.sideBias(windowSec),
    };
  }
}

export interface LiquidationSnapshot {
  volume30s: number;
  count30s: number;
  /** Positive = more longs liquidated (bearish), negative = more shorts (bullish). */
  sideBias30s: number;
}
