import type { Candle } from '../types';

export interface MultiTimeframeStoreOptions {
  /** Cap per (symbol, tf) series. Default 1000. */
  maxBars?: number;
  /**
   * M-1: hard ceiling on distinct symbols this store will track. A misconfig
   * (e.g. BINANCE_WATCHLIST accidentally set to the full exchange list) was
   * previously unbounded: 5000 symbols × 6 timeframes × maxBars × ~150B/bar
   * ≈ 4.5 GB and Node OOMs in the middle of the trading session. The cap is
   * advisory by default (logs + onSymbolCapExceeded callback) — set
   * `enforceSymbolCap: true` to make the store refuse new symbols once full.
   * Default 200, override via env (DASHBOARD_STORE_MAX_SYMBOLS).
   */
  maxSymbols?: number;
  enforceSymbolCap?: boolean;
  /** Called when a kline's OHLC looks anomalous vs recent bars. */
  onAnomalousBar?: (symbol: string, tf: string, candle: Candle, medianRange: number) => void;
  /** Called the first time `maxSymbols` is exceeded for a given symbol. */
  onSymbolCapExceeded?: (symbol: string, currentSymbolCount: number, cap: number) => void;
}

const ANOMALY_LOOKBACK = 20;
const ANOMALY_MULTIPLIER = 8;

export class MultiTimeframeStore {
  private readonly maxBars: number;
  private readonly maxSymbols: number;
  private readonly enforceSymbolCap: boolean;
  private readonly onAnomalousBar?: MultiTimeframeStoreOptions['onAnomalousBar'];
  private readonly onSymbolCapExceeded?: MultiTimeframeStoreOptions['onSymbolCapExceeded'];
  private series = new Map<string, Map<string, Candle[]>>();
  /** Symbols that were dropped because the cap is full + enforce=true. Logged once. */
  private capRejectedLogged = new Set<string>();

  constructor(opts: MultiTimeframeStoreOptions = {}) {
    this.maxBars = Math.max(10, opts.maxBars ?? 1000);
    this.maxSymbols = Math.max(1, opts.maxSymbols ?? 200);
    this.enforceSymbolCap = opts.enforceSymbolCap ?? false;
    this.onAnomalousBar = opts.onAnomalousBar;
    this.onSymbolCapExceeded = opts.onSymbolCapExceeded;
  }

  seed(symbol: string, tf: string, candles: Candle[]): void {
    if (this.capWouldBlock(symbol)) return;
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
    if (this.capWouldBlock(symbol)) return false;
    const arr = this.bucket(symbol, tf);
    // M-12: anomalous-bar detection LOGS but no longer DROPS. Dropping made
    // the bot blind to exactly the bars where the highest-edge trades live
    // (Fed announcements, liquidation cascades — multi-sigma range, real
    // events). The callback still fires so an operator can correlate
    // signals with anomalies. Strategy logic can opt out by checking
    // `candle.anomalous` if it cares.
    this.checkAnomaly(symbol, tf, candle, arr);
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
    if (this.capWouldBlock(symbol)) return;
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
    // Read-only path — do NOT create empty buckets on miss, otherwise a
    // dashboard query for an arbitrary symbol would bump symbolCount() and
    // potentially trip the M-1 cap. Same for `closes()` below.
    const key = this.k(symbol);
    const arr = this.series.get(key)?.get(tf);
    return arr ? [...arr] : [];
  }

  latest(symbol: string, tf: string): Candle | null {
    const arr = this.series.get(this.k(symbol))?.get(tf);
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1];
  }

  closes(symbol: string, tf: string): number[] {
    const key = this.k(symbol);
    const arr = this.series.get(key)?.get(tf);
    return arr ? arr.map((c) => c.close) : [];
  }

  private k(symbol: string): string {
    return symbol.toUpperCase();
  }

  /**
   * M-1: returns true when the symbol cap would block a NEW symbol from being
   * created. Existing symbols are always allowed. Fires the cap-exceeded
   * callback at most once per symbol. Called by applyKline / seed / forceApply
   * / prependOlder so all write paths honour the cap consistently.
   */
  private capWouldBlock(symbol: string): boolean {
    const key = this.k(symbol);
    if (this.series.has(key)) return false;
    if (this.series.size < this.maxSymbols) return false;
    if (!this.capRejectedLogged.has(key)) {
      this.capRejectedLogged.add(key);
      this.onSymbolCapExceeded?.(key, this.series.size, this.maxSymbols);
    }
    return this.enforceSymbolCap;
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

  /** Number of distinct symbols currently tracked. */
  public symbolCount(): number {
    return this.series.size;
  }

  /** Whether the symbol cap has been hit (informational; cap is advisory by default). */
  public isAtSymbolCap(): boolean {
    return this.series.size >= this.maxSymbols;
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
