import type { AggTradeTape } from './trade-tape';
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

// ─── Spread in Basis Points ──────────────────────────────────────────────

/** Spread as basis points relative to mid price. Returns null if book is empty. */
export const spreadBps = (book: LocalOrderBook): number | null => {
  const s = book.spread();
  const mid = book.midPrice();
  if (s === null || mid === null || mid <= 0) return null;
  return (s / mid) * 10_000;
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
}

export const snapshotMicrostructure = (
  tape: AggTradeTape,
  book: LocalOrderBook,
): MicrostructureSnapshot => ({
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
});
