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

export interface MicrostructureSnapshot {
  tfi1s: TradeFlowImbalance;
  tfi5s: TradeFlowImbalance;
  tfi30s: TradeFlowImbalance;
  weightedObi5: WeightedObiResult;
  weightedObi10: WeightedObiResult;
  microprice: number | null;
  spread: number | null;
  mid: number | null;
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
  mid: book.midPrice(),
});
