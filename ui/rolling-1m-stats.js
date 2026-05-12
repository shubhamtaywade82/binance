/** Rolling window for trade-based VWAP (milliseconds). */
const WINDOW_MS = 60_000;

/**
 * Keeps agg trades from the last 60s for VWAP = Σ(price×qty) / Σ(qty) and total volume.
 * Used for the Market Sentiment "1m VWAP" / "Vol 1m" row (trade tape, not calendar candles).
 */
export class Rolling1mTradeStats {
  constructor() {
    /** @type {{ price: number; qty: number; ts: number }[]} */
    this.trades = [];
  }

  reset() {
    this.trades = [];
  }

  /** @param {unknown} price @param {unknown} qty @param {unknown} ts */
  ingest(price, qty, ts) {
    const p = Number(price);
    const q = Number(qty);
    const t = Number(ts);
    if (!Number.isFinite(p) || !Number.isFinite(q) || !Number.isFinite(t) || q <= 0) return;
    this.trades.push({ price: p, qty: q, ts: t });
    const cutoff = t - WINDOW_MS;
    while (this.trades.length > 0 && this.trades[0].ts < cutoff) this.trades.shift();
  }

  /** @returns {{ vwap: number | null; volume: number | null }} */
  snapshot() {
    if (this.trades.length === 0) return { vwap: null, volume: null };
    let pv = 0;
    let v = 0;
    for (const x of this.trades) {
      pv += x.price * x.qty;
      v += x.qty;
    }
    if (v <= 0) return { vwap: null, volume: null };
    return { vwap: pv / v, volume: v };
  }
}
