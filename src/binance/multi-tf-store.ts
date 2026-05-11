import type { Candle } from '../types';

export interface MultiTimeframeStoreOptions {
  /** Cap per (symbol, tf) series. Default 1000. */
  maxBars?: number;
}

export class MultiTimeframeStore {
  private readonly maxBars: number;
  private series = new Map<string, Map<string, Candle[]>>();

  constructor(opts: MultiTimeframeStoreOptions = {}) {
    this.maxBars = Math.max(10, opts.maxBars ?? 1000);
  }

  seed(symbol: string, tf: string, candles: Candle[]): void {
    const arr = this.bucket(symbol, tf);
    arr.length = 0;
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    const dedup: Candle[] = [];
    let prevT = -Infinity;
    for (const c of sorted) {
      if (c.openTime === prevT) {
        dedup[dedup.length - 1] = c;
      } else {
        dedup.push(c);
        prevT = c.openTime;
      }
    }
    arr.push(...dedup);
    this.cap(arr);
  }

  applyKline(symbol: string, tf: string, candle: Candle, _isFinal: boolean): void {
    const arr = this.bucket(symbol, tf);
    if (arr.length === 0) {
      arr.push(candle);
      return;
    }
    const last = arr[arr.length - 1];
    if (candle.openTime === last.openTime) {
      arr[arr.length - 1] = candle;
      return;
    }
    if (candle.openTime > last.openTime) {
      arr.push(candle);
      this.cap(arr);
      return;
    }
    const idx = arr.findIndex((c) => c.openTime === candle.openTime);
    if (idx >= 0) arr[idx] = candle;
    else {
      arr.push(candle);
      arr.sort((a, b) => a.openTime - b.openTime);
      this.cap(arr);
    }
  }

  has(symbol: string, tf: string): boolean {
    return (this.series.get(this.k(symbol))?.get(tf)?.length ?? 0) > 0;
  }

  getSeries(symbol: string, tf: string): Candle[] {
    return [...this.bucket(symbol, tf)];
  }

  latest(symbol: string, tf: string): Candle | null {
    const arr = this.series.get(this.k(symbol))?.get(tf);
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1];
  }

  closes(symbol: string, tf: string): number[] {
    return this.bucket(symbol, tf).map((c) => c.close);
  }

  private k(symbol: string): string {
    return symbol.toUpperCase();
  }

  private bucket(symbol: string, tf: string): Candle[] {
    const key = this.k(symbol);
    let m = this.series.get(key);
    if (!m) {
      m = new Map<string, Candle[]>();
      this.series.set(key, m);
    }
    let arr = m.get(tf);
    if (!arr) {
      arr = [];
      m.set(tf, arr);
    }
    return arr;
  }

  private cap(arr: Candle[]): void {
    if (arr.length > this.maxBars) arr.splice(0, arr.length - this.maxBars);
  }
}
