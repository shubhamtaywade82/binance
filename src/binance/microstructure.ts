import type { AggTradeEntry, AggTradeTape } from './trade-tape';
import type { LocalOrderBook, PriceLevel } from './orderbook';

export interface TradeFlowImbalance {
  /** Buy volume − sell volume over the window. */
  tfi: number;
  buyVol: number;
  sellVol: number;
  tradeCount: number;
}

export const tradeFlowImbalance = (tape: AggTradeTape, windowSec: number): TradeFlowImbalance => {
  const trades = tape.recent(windowSec);
  let buyVol = 0;
  let sellVol = 0;
  for (const t of trades) {
    if (t.makerSide) buyVol += t.qty;
    else sellVol += t.qty;
  }
  return { tfi: buyVol - sellVol, buyVol, sellVol, tradeCount: trades.length };
};

export interface WeightedObiResult {
  /** Weighted imbalance in [−1, 1]. Positive = bid-heavy. */
  weightedObi: number;
  bidWeightedVol: number;
  askWeightedVol: number;
}

/**
 * OBI where closer levels count more. Each level's volume is divided by
 * `1 + distanceFromMid / midPrice`, so levels right at mid have weight ~1
 * and distant levels are dampened.
 */
export const weightedObi = (book: LocalOrderBook, levels: number): WeightedObiResult => {
  const mid = book.midPrice();
  if (mid === null || mid <= 0) return { weightedObi: 0, bidWeightedVol: 0, askWeightedVol: 0 };

  const { bids, asks } = book.topLevels(levels);

  const weightSide = (side: PriceLevel[]): number => {
    let total = 0;
    for (const lvl of side) {
      const dist = Math.abs(lvl.price - mid);
      total += lvl.qty / (1 + dist / mid);
    }
    return total;
  };

  const bidW = weightSide(bids);
  const askW = weightSide(asks);
  const denom = bidW + askW;
  return {
    weightedObi: denom > 0 ? (bidW - askW) / denom : 0,
    bidWeightedVol: bidW,
    askWeightedVol: askW,
  };
};

/**
 * Volume-weighted mid: `(ask × bidVol + bid × askVol) / (bidVol + askVol)`.
 * Better fair-price estimate than arithmetic mid when book is asymmetric.
 */
export const microprice = (book: LocalOrderBook): number | null => {
  const bid = book.bestBid();
  const ask = book.bestAsk();
  if (!bid || !ask) return null;
  const denom = bid.qty + ask.qty;
  if (denom <= 0) return null;
  return (ask.price * bid.qty + bid.price * ask.qty) / denom;
};

// ─── Depth Pressure ──────────────────────────────────────────────────────

export interface DepthPressureResult {
  /** Positive = bid-heavy pressure, negative = ask-heavy. */
  depthPressure: number;
  bidPressure: number;
  askPressure: number;
}

/**
 * Σ(bid_vol / distance_from_mid) − Σ(ask_vol / distance_from_mid).
 * Levels closer to mid contribute exponentially more than distant ones.
 */
export const depthPressure = (book: LocalOrderBook, levels: number): DepthPressureResult => {
  const mid = book.midPrice();
  if (mid === null || mid <= 0) return { depthPressure: 0, bidPressure: 0, askPressure: 0 };

  const { bids, asks } = book.topLevels(levels);

  const pressureSide = (side: PriceLevel[]): number => {
    let total = 0;
    for (const lvl of side) {
      const dist = Math.abs(lvl.price - mid);
      if (dist > 0) total += lvl.qty / dist;
    }
    return total;
  };

  const bidP = pressureSide(bids);
  const askP = pressureSide(asks);
  return { depthPressure: bidP - askP, bidPressure: bidP, askPressure: askP };
};

// ─── Order Flow Imbalance (OFI) ─────────────────────────────────────────

export interface OfiTracker {
  prevBestBidQty: number;
  prevBestAskQty: number;
  prevBestBidPx: number;
  prevBestAskPx: number;
  cumulativeOfi: number;
}

export const createOfiTracker = (): OfiTracker => ({
  prevBestBidQty: 0,
  prevBestAskQty: 0,
  prevBestBidPx: 0,
  prevBestAskPx: 0,
  cumulativeOfi: 0,
});

/**
 * Update OFI on each depth diff event. Returns the incremental OFI delta.
 *
 * OFI = Δbid_size − Δask_size at best levels, accounting for price changes:
 * - If best bid price rises, old bid qty is "added" (positive delta).
 * - If best bid price drops, old bid qty is "removed" (negative delta).
 * - Mirror logic for asks.
 */
export const updateOfi = (tracker: OfiTracker, book: LocalOrderBook): number => {
  const bid = book.bestBid();
  const ask = book.bestAsk();
  if (!bid || !ask) return 0;

  let deltaBid = 0;
  if (bid.price > tracker.prevBestBidPx) {
    deltaBid = bid.qty;
  } else if (bid.price === tracker.prevBestBidPx) {
    deltaBid = bid.qty - tracker.prevBestBidQty;
  } else {
    deltaBid = -tracker.prevBestBidQty;
  }

  let deltaAsk = 0;
  if (ask.price < tracker.prevBestAskPx) {
    deltaAsk = ask.qty;
  } else if (ask.price === tracker.prevBestAskPx) {
    deltaAsk = ask.qty - tracker.prevBestAskQty;
  } else {
    deltaAsk = -tracker.prevBestAskQty;
  }

  const ofiDelta = deltaBid - deltaAsk;
  tracker.cumulativeOfi += ofiDelta;

  tracker.prevBestBidPx = bid.price;
  tracker.prevBestBidQty = bid.qty;
  tracker.prevBestAskPx = ask.price;
  tracker.prevBestAskQty = ask.qty;

  return ofiDelta;
};

// ─── Rolling Realized Volatility ─────────────────────────────────────────

export interface RealizedVolResult {
  /** Annualized realized vol (or raw std of log returns if not enough data). */
  rv: number;
  /** Number of log-return samples used. */
  sampleCount: number;
}

/**
 * Rolling realized volatility from trade tape: √(Σ log-return²) over a window.
 * Uses trade-to-trade log returns within the window.
 */
export const rollingRealizedVol = (tape: AggTradeTape, windowSec: number): RealizedVolResult => {
  const trades = tape.recent(windowSec);
  if (trades.length < 2) return { rv: 0, sampleCount: 0 };

  let sumSq = 0;
  for (let i = 1; i < trades.length; i++) {
    const logRet = Math.log(trades[i].price / trades[i - 1].price);
    sumSq += logRet * logRet;
  }
  const n = trades.length - 1;
  return { rv: Math.sqrt(sumSq / n), sampleCount: n };
};

// ─── Sub-minute OHLCV micro bars (agg trade tape) ───────────────────────────

export interface MicroOhlcvBar {
  /** Bucket open time (ms), aligned to `intervalMs`. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  buyV: number;
  sellV: number;
  n: number;
}

/**
 * Buckets trades into OHLCV bars of width `intervalMs` (e.g. 1000 or 5000).
 * Trades are sorted by time so `open` reflects the first print in the bucket.
 */
export const tradesToOhlcvBars = (
  trades: ReadonlyArray<Pick<AggTradeEntry, 'price' | 'qty' | 'ts' | 'makerSide'>>,
  intervalMs: number,
): Map<number, MicroOhlcvBar> => {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const m = new Map<number, MicroOhlcvBar>();
  for (const tr of sorted) {
    const t0 = Math.floor(tr.ts / intervalMs) * intervalMs;
    let b = m.get(t0);
    if (!b) {
      b = { t: t0, o: tr.price, h: tr.price, l: tr.price, c: tr.price, v: 0, buyV: 0, sellV: 0, n: 0 };
      m.set(t0, b);
    }
    b.h = Math.max(b.h, tr.price);
    b.l = Math.min(b.l, tr.price);
    b.c = tr.price;
    b.v += tr.qty;
    b.n += 1;
    if (tr.makerSide) b.buyV += tr.qty;
    else b.sellV += tr.qty;
  }
  return m;
};

export const ohlcvBarsChronological = (barMap: Map<number, MicroOhlcvBar>): MicroOhlcvBar[] =>
  [...barMap.values()].sort((a, b) => a.t - b.t);

export const microOhlcvBarsFromTape = (
  tape: AggTradeTape,
  lookbackSec = 120,
): { bars1s: MicroOhlcvBar[]; bars5s: MicroOhlcvBar[] } => {
  const trades = tape.recent(lookbackSec);
  if (trades.length === 0) return { bars1s: [], bars5s: [] };
  const bars1s = ohlcvBarsChronological(tradesToOhlcvBars(trades, 1000)).slice(-60);
  const bars5s = ohlcvBarsChronological(tradesToOhlcvBars(trades, 5000)).slice(-36);
  return { bars1s, bars5s };
};

/** log(close[last] / close[prev]); 0 if fewer than two bars or invalid prices. */
export const microBarCloseRet = (bars: MicroOhlcvBar[]): number => {
  if (bars.length < 2) return 0;
  const a = bars[bars.length - 2].c;
  const b = bars[bars.length - 1].c;
  if (a <= 0 || b <= 0 || !Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.log(b / a);
};

export const microBarLastVolume = (bars: MicroOhlcvBar[]): number => {
  if (bars.length === 0) return 0;
  const v = bars[bars.length - 1].v;
  return Number.isFinite(v) ? v : 0;
};

// ─── Spread in Basis Points ──────────────────────────────────────────────

/** Spread as basis points relative to mid price. Returns null if book is empty. */
export const spreadBps = (book: LocalOrderBook): number | null => {
  const s = book.spread();
  const mid = book.midPrice();
  if (s === null || mid === null || mid <= 0) return null;
  return (s / mid) * 10_000;
};

// ─── Book Slope ──────────────────────────────────────────────────────────

export interface BookSlopeResult {
  bidSlope: number;
  askSlope: number;
}

/**
 * Volume-weighted price gradient: Σ(qty × distance) / Σ(qty) for each side.
 * Higher slope = volume is concentrated away from best; lower = clustered near top.
 */
export const bookSlope = (book: LocalOrderBook, levels: number): BookSlopeResult => {
  const mid = book.midPrice();
  if (mid === null || mid <= 0) return { bidSlope: 0, askSlope: 0 };

  const { bids, asks } = book.topLevels(levels);

  const slopeOfSide = (side: PriceLevel[]): number => {
    let weightedDist = 0;
    let totalQty = 0;
    for (const lvl of side) {
      const dist = Math.abs(lvl.price - mid);
      weightedDist += lvl.qty * dist;
      totalQty += lvl.qty;
    }
    return totalQty > 0 ? weightedDist / totalQty : 0;
  };

  return { bidSlope: slopeOfSide(bids), askSlope: slopeOfSide(asks) };
};

// ─── Liquidity Gap ───────────────────────────────────────────────────────

/**
 * Largest price gap between consecutive levels in the top N of each side.
 * Returns the max of bid-side and ask-side gaps. Signals thin liquidity pockets.
 */
export const liquidityGap = (book: LocalOrderBook, levels: number): number => {
  const { bids, asks } = book.topLevels(levels);

  const maxGap = (side: PriceLevel[]): number => {
    if (side.length < 2) return 0;
    let gap = 0;
    for (let i = 1; i < side.length; i++) {
      gap = Math.max(gap, Math.abs(side[i].price - side[i - 1].price));
    }
    return gap;
  };

  return Math.max(maxGap(bids), maxGap(asks));
};

// ─── Trade Flow Extended ─────────────────────────────────────────────────

export interface TradeFlowExtended {
  signedVolume: number;
  burstiness: number;
  directionStreak: number;
  largeTradeFlag: number;
}

/**
 * Extended trade flow features from the aggTrade tape.
 * - signedVolume: net buy - sell volume (same as TFI but explicit naming)
 * - burstiness: coefficient of variation of inter-trade arrival times (higher = more bursty)
 * - directionStreak: consecutive trades on the same side (positive = buys, negative = sells)
 * - largeTradeFlag: 1 if the latest trade qty > 3× rolling avg qty, else 0
 */
export const tradeFlowExtended = (tape: AggTradeTape, windowSec: number): TradeFlowExtended => {
  const trades = tape.recent(windowSec);
  if (trades.length < 2) {
    return { signedVolume: 0, burstiness: 0, directionStreak: 0, largeTradeFlag: 0 };
  }

  let buyVol = 0;
  let sellVol = 0;
  const interArrivals: number[] = [];

  for (let i = 0; i < trades.length; i++) {
    if (trades[i].makerSide) buyVol += trades[i].qty;
    else sellVol += trades[i].qty;
    if (i > 0) interArrivals.push(trades[i].ts - trades[i - 1].ts);
  }

  let burstiness = 0;
  if (interArrivals.length > 1) {
    const mean = interArrivals.reduce((a, b) => a + b, 0) / interArrivals.length;
    if (mean > 0) {
      const variance = interArrivals.reduce((s, v) => s + (v - mean) ** 2, 0) / interArrivals.length;
      burstiness = Math.sqrt(variance) / mean;
    }
  }

  let streak = 0;
  const last = trades[trades.length - 1];
  const lastDir = last.makerSide;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].makerSide !== lastDir) break;
    streak++;
  }
  const directionStreak = lastDir ? streak : -streak;

  const avgQty = trades.reduce((s, t) => s + t.qty, 0) / trades.length;
  const largeTradeFlag = last.qty > 3 * avgQty ? 1 : 0;

  return {
    signedVolume: buyVol - sellVol,
    burstiness,
    directionStreak,
    largeTradeFlag,
  };
};

// ─── Candle-Derived Features ─────────────────────────────────────────────

export interface CandleDerivedFeatures {
  volumeZscore: number;
  rangeExpansion: number;
  trendSlope: number;
  momentum: number;
}

/**
 * Compute candle-derived features from a series of candles.
 * - volumeZscore: latest bar volume vs rolling mean/std
 * - rangeExpansion: latest bar range vs N-bar average range
 * - trendSlope: linear regression slope of closes over last N bars (normalized by mean close)
 * - momentum: close-to-close return over N bars
 */
export const candleDerivedFeatures = (
  candles: ReadonlyArray<{ open: number; high: number; low: number; close: number; volume: number }>,
  lookback = 20,
): CandleDerivedFeatures => {
  if (candles.length < 3) {
    return { volumeZscore: 0, rangeExpansion: 0, trendSlope: 0, momentum: 0 };
  }

  const n = Math.min(lookback, candles.length);
  const recent = candles.slice(-n);
  const latest = recent[recent.length - 1];

  const volumes = recent.map((c) => c.volume);
  const vMean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const vStd = Math.sqrt(volumes.reduce((s, v) => s + (v - vMean) ** 2, 0) / volumes.length);
  const volumeZscore = vStd > 0 ? (latest.volume - vMean) / vStd : 0;

  const ranges = recent.map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const latestRange = latest.high - latest.low;
  const rangeExpansion = avgRange > 0 ? latestRange / avgRange : 0;

  const closes = recent.map((c) => c.close);
  const meanClose = closes.reduce((a, b) => a + b, 0) / closes.length;
  let sumXY = 0;
  let sumX2 = 0;
  const halfN = (closes.length - 1) / 2;
  for (let i = 0; i < closes.length; i++) {
    const x = i - halfN;
    sumXY += x * closes[i];
    sumX2 += x * x;
  }
  const trendSlope = sumX2 > 0 && meanClose > 0 ? (sumXY / sumX2) / meanClose : 0;

  const first = recent[0];
  const momentum = first.close > 0 ? Math.log(latest.close / first.close) : 0;

  return { volumeZscore, rangeExpansion, trendSlope, momentum };
};

// ─── Extended Snapshot ───────────────────────────────────────────────────

export interface MicrostructureSnapshot {
  tfi1s: TradeFlowImbalance;
  tfi5s: TradeFlowImbalance;
  tfi30s: TradeFlowImbalance;
  weightedObi5: WeightedObiResult;
  weightedObi10: WeightedObiResult;
  microprice: number | null;
  spread: number | null;
  spreadBps: number | null;
  mid: number | null;
  depthPressure10: DepthPressureResult;
  rv1s: RealizedVolResult;
  rv5s: RealizedVolResult;
  rv1m: RealizedVolResult;
  /** Fixed 1s OHLCV buckets from agg trades (recent tail). */
  microBars1s: MicroOhlcvBar[];
  /** Fixed 5s OHLCV buckets from agg trades (recent tail). */
  microBars5s: MicroOhlcvBar[];
}

export const snapshotMicrostructure = (
  tape: AggTradeTape,
  book: LocalOrderBook,
): MicrostructureSnapshot => {
  const { bars1s, bars5s } = microOhlcvBarsFromTape(tape, 120);
  return {
    tfi1s: tradeFlowImbalance(tape, 1),
    tfi5s: tradeFlowImbalance(tape, 5),
    tfi30s: tradeFlowImbalance(tape, 30),
    weightedObi5: weightedObi(book, 5),
    weightedObi10: weightedObi(book, 10),
    microprice: microprice(book),
    spread: book.spread(),
    spreadBps: spreadBps(book),
    mid: book.midPrice(),
    depthPressure10: depthPressure(book, 10),
    rv1s: rollingRealizedVol(tape, 1),
    rv5s: rollingRealizedVol(tape, 5),
    rv1m: rollingRealizedVol(tape, 60),
    microBars1s: bars1s,
    microBars5s: bars5s,
  };
};
