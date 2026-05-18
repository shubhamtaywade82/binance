import type { Candle } from '../types';

export interface MultiTimeframeStoreOptions {
  /** Cap per (symbol, tf) series. Default 1000. */
  maxBars?: number;
  /** Called when a kline's OHLC looks anomalous vs recent bars. */
  onAnomalousBar?: (symbol: string, tf: string, candle: Candle, medianRange: number) => void;
}

const ANOMALY_LOOKBACK = 20;
const ANOMALY_MULTIPLIER = 8;

export class MultiTimeframeStore {
  private readonly maxBars: number;
  private readonly onAnomalousBar?: MultiTimeframeStoreOptions['onAnomalousBar'];
  private series = new Map<string, Map<string, Candle[]>>();

  constructor(opts: MultiTimeframeStoreOptions = {}) {
    this.maxBars = Math.max(10, opts.maxBars ?? 1000);
    this.onAnomalousBar = opts.onAnomalousBar;
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

  applyKline(symbol: string, tf: string, candle: Candle, isFinal: boolean): boolean {
    const arr = this.bucket(symbol, tf);
    if (this.checkAnomaly(symbol, tf, candle, arr)) return false;
    // C-10: tag the bar with its seal state before insert so downstream
    // indicators / replay logic can distinguish closed bars from the live tip.
    const stamped: Candle = candle.sealed === undefined
      ? { ...candle, sealed: isFinal }
      : candle;
    this.insertCandle(arr, stamped);
    return true;
  }

  /** Apply candle unconditionally (skip anomaly check). Used after REST confirms bar is valid. */
  forceApplyKline(symbol: string, tf: string, candle: Candle): void {
    const arr = this.bucket(symbol, tf);
    // REST historical bars are always closed.
    const stamped: Candle = candle.sealed === undefined ? { ...candle, sealed: true } : candle;
    this.insertCandle(arr, stamped);
  }

  private insertCandle(arr: Candle[], candle: Candle): void {
    if (arr.length === 0) {
      arr.push(candle);
      return;
    }
    const last = arr[arr.length - 1];
    if (candle.openTime === last.openTime) {
      // C-10: never let a non-final update overwrite a sealed bar. A late
      // network re-broadcast of an x=false kline AFTER the x=true close
      // arrived would otherwise rewrite history (the repaint bug).
      if (last.sealed && !candle.sealed) return;
      arr[arr.length - 1] = candle;
      return;
    }
    if (candle.openTime > last.openTime) {
      arr.push(candle);
      this.cap(arr);
      return;
    }
    const idx = arr.findIndex((c) => c.openTime === candle.openTime);
    if (idx >= 0) {
      // Same sealed-bar protection for out-of-order historical inserts.
      const existing = arr[idx];
      if (existing.sealed && !candle.sealed) return;
      arr[idx] = candle;
    } else {
      arr.push(candle);
      arr.sort((a, b) => a.openTime - b.openTime);
      this.cap(arr);
    }
  }

  /**
   * Compare incoming bar range vs median of recent bars.
   * Returns `true` (reject) when the range is anomalous — caller must validate via REST before accepting.
   */
  private checkAnomaly(symbol: string, tf: string, candle: Candle, arr: Candle[]): boolean {
    if (!this.onAnomalousBar || arr.length < ANOMALY_LOOKBACK) return false;
    const tail = arr.slice(-ANOMALY_LOOKBACK);
    const ranges = tail.map((c) => Math.abs(c.high - c.low)).sort((a, b) => a - b);
    const median = ranges[Math.floor(ranges.length / 2)];
    if (median <= 0) return false;
    const incoming = Math.abs(candle.high - candle.low);
    if (incoming > median * ANOMALY_MULTIPLIER) {
      this.onAnomalousBar(symbol, tf, candle, median);
      return true;
    }
    return false;
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

  /**
   * Compare the last `depth` bars in the store against a fresh REST fetch.
   * Returns mismatched openTimes (OHLC differs) so the caller can decide to reseed.
   */
  validateAgainstRest(symbol: string, tf: string, restBars: Candle[]): { mismatched: number[]; missing: number[] } {
    const arr = this.bucket(symbol, tf);
    const storeByTime = new Map<number, Candle>();
    for (const c of arr) storeByTime.set(c.openTime, c);

    const mismatched: number[] = [];
    const missing: number[] = [];
    for (const r of restBars) {
      const s = storeByTime.get(r.openTime);
      if (!s) {
        missing.push(r.openTime);
        continue;
      }
      if (s.open !== r.open || s.high !== r.high || s.low !== r.low || s.close !== r.close) {
        mismatched.push(r.openTime);
      }
    }
    return { mismatched, missing };
  }

  /** Replace the tail of a series with fresh REST data (keeps older history intact). */
  reseedTail(symbol: string, tf: string, freshBars: Candle[]): void {
    if (!freshBars.length) return;
    const arr = this.bucket(symbol, tf);
    const cutoff = freshBars[0].openTime;
    const kept = arr.filter((c) => c.openTime < cutoff);
    const merged = [...kept, ...freshBars].sort((a, b) => a.openTime - b.openTime);
    const dedup: Candle[] = [];
    for (const c of merged) {
      if (dedup.length && dedup[dedup.length - 1]!.openTime === c.openTime) {
        dedup[dedup.length - 1] = c;
      } else {
        dedup.push(c);
      }
    }
    arr.length = 0;
    arr.push(...dedup);
    this.cap(arr);
  }

  private cap(arr: Candle[]): void {
    if (arr.length > this.maxBars) arr.splice(0, arr.length - this.maxBars);
  }

  /**
   * Merges older candles before the current series (REST backfill / lazy history).
   * On duplicate `openTime`, the value already in the series wins over the incoming fetch
   * (stable sort of `[...older, ...existing]` keeps the live bar last for that timestamp).
   */
  prependOlder(symbol: string, tf: string, older: Candle[]): void {
    if (!older.length) return;
    const arr = this.bucket(symbol, tf);
    const merged = [...older, ...arr].sort((a, b) => a.openTime - b.openTime);
    const dedup: Candle[] = [];
    for (const c of merged) {
      if (dedup.length && dedup[dedup.length - 1]!.openTime === c.openTime) {
        dedup[dedup.length - 1] = c;
      } else {
        dedup.push(c);
      }
    }
    arr.length = 0;
    arr.push(...dedup);
    this.cap(arr);
  }
}
