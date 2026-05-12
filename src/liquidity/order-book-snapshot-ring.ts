import type { LocalOrderBook, PriceLevel } from '../binance/orderbook';

/** Slim book state for sweep attribution (JSON-safe). */
export interface OrderBookMicroSnapshot {
  ts: number;
  bestBid: number | null;
  bestAsk: number | null;
  bidNotional: number;
  askNotional: number;
  /** (bidNotional - askNotional) / (bidNotional + askNotional); 0 if empty. */
  imbalance: number;
  bids: { price: number; qty: number }[];
  asks: { price: number; qty: number }[];
}

function notionalSum(levels: PriceLevel[]): number {
  let s = 0;
  for (const x of levels) s += x.price * x.qty;
  return s;
}

function cloneLevels(levels: PriceLevel[], max: number): { price: number; qty: number }[] {
  return levels.slice(0, max).map((x) => ({ price: x.price, qty: x.qty }));
}

export function snapshotFromOrderBook(
  ob: LocalOrderBook,
  depthLevels: number,
  ts: number,
): OrderBookMicroSnapshot | null {
  if (!ob.isBootstrapped()) return null;
  const n = Math.max(1, Math.min(50, depthLevels));
  const { bids, asks } = ob.topLevels(n);
  if (bids.length === 0 && asks.length === 0) return null;
  const bidN = notionalSum(bids);
  const askN = notionalSum(asks);
  const denom = bidN + askN;
  const imbalance = denom > 0 ? (bidN - askN) / denom : 0;
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  return {
    ts,
    bestBid,
    bestAsk,
    bidNotional: +bidN.toFixed(8),
    askNotional: +askN.toFixed(8),
    imbalance: +imbalance.toFixed(6),
    bids: cloneLevels(bids, 8),
    asks: cloneLevels(asks, 8),
  };
}

type RingEntry = { ts: number; snap: OrderBookMicroSnapshot };

export interface OrderBookSnapshotRingOptions {
  maxPerSymbol?: number;
  maxAgeMs?: number;
  /** Top N levels passed to `topLevels` when recording. */
  depthLevels?: number;
}

/**
 * Time-ordered ring of order-book micro-snapshots per symbol so liquidity sweeps can be
 * attributed to depth state near the sweep candle's time. Bounded memory; optional release
 * after a sweep is marked.
 */
export class OrderBookSnapshotRing {
  private readonly rings = new Map<string, RingEntry[]>();
  private readonly released = new Set<string>();
  private readonly maxPerSymbol: number;
  private readonly maxAgeMs: number;
  private readonly depthLevels: number;

  constructor(opts: OrderBookSnapshotRingOptions = {}) {
    this.maxPerSymbol = opts.maxPerSymbol ?? 1800;
    this.maxAgeMs = opts.maxAgeMs ?? 120_000;
    this.depthLevels = opts.depthLevels ?? 20;
  }

  recordFromBook(symbolUpper: string, ob: LocalOrderBook, eventTsMs = Date.now()): void {
    const sym = symbolUpper.trim().toUpperCase();
    if (!sym) return;
    const snap = snapshotFromOrderBook(ob, this.depthLevels, eventTsMs);
    if (!snap) return;
    let ring = this.rings.get(sym);
    if (!ring) {
      ring = [];
      this.rings.set(sym, ring);
    }
    const last = ring[ring.length - 1];
    if (last && last.ts === snap.ts && last.snap.bestBid === snap.bestBid && last.snap.bestAsk === snap.bestAsk) {
      last.snap = snap;
      return;
    }
    ring.push({ ts: snap.ts, snap });
    this.prune(sym, eventTsMs);
    while (ring.length > this.maxPerSymbol) ring.shift();
  }

  private prune(sym: string, nowMs: number): void {
    const ring = this.rings.get(sym);
    if (!ring) return;
    const cutoff = nowMs - this.maxAgeMs;
    while (ring.length > 0 && ring[0]!.ts < cutoff) ring.shift();
  }

  /**
   * Closest snapshot to `targetMs` within ±`windowMs` (by absolute time delta).
   */
  nearest(symbolUpper: string, targetMs: number, windowMs: number): OrderBookMicroSnapshot | null {
    const sym = symbolUpper.trim().toUpperCase();
    const ring = this.rings.get(sym);
    if (!ring || ring.length === 0 || !Number.isFinite(targetMs)) return null;
    let best: OrderBookMicroSnapshot | null = null;
    let bestD = Infinity;
    for (const e of ring) {
      const d = Math.abs(e.ts - targetMs);
      if (d <= windowMs && d < bestD) {
        bestD = d;
        best = e.snap;
      }
    }
    return best;
  }

  /**
   * Drop ring entries whose timestamps fall in `[targetMs - windowMs, targetMs + windowMs]`
   * once per `(sym, barOpenTime)` key so repeated signal broadcasts do not wipe the ring.
   */
  releaseAfterSweep(symbolUpper: string, barOpenTime: number, windowMs: number): void {
    const sym = symbolUpper.trim().toUpperCase();
    if (!sym || !Number.isFinite(barOpenTime)) return;
    const key = `${sym}:${Math.trunc(barOpenTime)}`;
    if (this.released.has(key)) return;
    this.released.add(key);
    const ring = this.rings.get(sym);
    if (!ring) return;
    const lo = barOpenTime - windowMs;
    const hi = barOpenTime + windowMs;
    const kept = ring.filter((e) => e.ts < lo || e.ts > hi);
    if (kept.length === 0) this.rings.delete(sym);
    else this.rings.set(sym, kept);
    if (this.released.size > 5000) this.released.clear();
  }
}
