import { describe, it, expect, beforeEach } from 'vitest';
import {
  bookSlope,
  liquidityGap,
  tradeFlowExtended,
  candleDerivedFeatures,
} from '../src/binance/microstructure';
import { LocalOrderBook } from '../src/binance/orderbook';
import { AggTradeTape } from '../src/binance/trade-tape';
import { DepthChangeTracker } from '../src/binance/depth-change-tracker';

const buildBook = (bids: [number, number][], asks: [number, number][]): LocalOrderBook => {
  const book = new LocalOrderBook();
  book.bootstrap({
    lastUpdateId: 1,
    bids: bids.map(([p, q]) => [p, q]),
    asks: asks.map(([p, q]) => [p, q]),
  });
  return book;
};

const pushTrades = (tape: AggTradeTape, entries: { price: number; qty: number; ts: number; makerSide: boolean }[]) => {
  for (const e of entries) tape.push(e);
};

describe('bookSlope', () => {
  it('returns zero for empty book', () => {
    const book = new LocalOrderBook();
    const result = bookSlope(book, 5);
    expect(result.bidSlope).toBe(0);
    expect(result.askSlope).toBe(0);
  });

  it('computes volume-weighted distance from mid', () => {
    const book = buildBook(
      [[100, 10], [99, 20], [98, 30]],
      [[101, 10], [102, 20], [103, 30]],
    );
    const result = bookSlope(book, 3);
    expect(result.bidSlope).toBeGreaterThan(0);
    expect(result.askSlope).toBeGreaterThan(0);
  });

  it('bid slope increases when volume is further from mid', () => {
    const nearBook = buildBook([[100, 100], [99, 1]], [[101, 100], [102, 1]]);
    const farBook = buildBook([[100, 1], [99, 100]], [[101, 1], [102, 100]]);
    const near = bookSlope(nearBook, 2);
    const far = bookSlope(farBook, 2);
    expect(far.bidSlope).toBeGreaterThan(near.bidSlope);
    expect(far.askSlope).toBeGreaterThan(near.askSlope);
  });
});

describe('liquidityGap', () => {
  it('returns zero with fewer than 2 levels', () => {
    const book = buildBook([[100, 10]], [[101, 10]]);
    expect(liquidityGap(book, 5)).toBe(0);
  });

  it('detects the largest gap between consecutive levels', () => {
    const book = buildBook(
      [[100, 10], [99, 10], [95, 10]],
      [[101, 10], [102, 10], [103, 10]],
    );
    const gap = liquidityGap(book, 5);
    expect(gap).toBe(4);
  });
});

describe('tradeFlowExtended', () => {
  let tape: AggTradeTape;

  beforeEach(() => { tape = new AggTradeTape(100); });

  it('returns zeros for empty tape', () => {
    const result = tradeFlowExtended(tape, 5);
    expect(result.signedVolume).toBe(0);
    expect(result.burstiness).toBe(0);
    expect(result.directionStreak).toBe(0);
    expect(result.largeTradeFlag).toBe(0);
  });

  it('computes net signed volume', () => {
    const now = Date.now();
    pushTrades(tape, [
      { price: 100, qty: 5, ts: now - 2000, makerSide: true },
      { price: 100, qty: 3, ts: now - 1000, makerSide: false },
      { price: 100, qty: 4, ts: now, makerSide: true },
    ]);
    const result = tradeFlowExtended(tape, 5);
    expect(result.signedVolume).toBe(9 - 3);
  });

  it('detects consecutive same-side trades as direction streak', () => {
    const now = Date.now();
    pushTrades(tape, [
      { price: 100, qty: 1, ts: now - 3000, makerSide: false },
      { price: 100, qty: 1, ts: now - 2000, makerSide: true },
      { price: 100, qty: 1, ts: now - 1000, makerSide: true },
      { price: 100, qty: 1, ts: now, makerSide: true },
    ]);
    const result = tradeFlowExtended(tape, 5);
    expect(result.directionStreak).toBe(3);
  });

  it('flags large trades relative to average', () => {
    const now = Date.now();
    pushTrades(tape, [
      { price: 100, qty: 1, ts: now - 3000, makerSide: true },
      { price: 100, qty: 1, ts: now - 2000, makerSide: true },
      { price: 100, qty: 1, ts: now - 1000, makerSide: true },
      { price: 100, qty: 10, ts: now, makerSide: true },
    ]);
    const result = tradeFlowExtended(tape, 5);
    expect(result.largeTradeFlag).toBe(1);
  });

  it('computes burstiness as coefficient of variation of inter-arrival times', () => {
    const now = Date.now();
    pushTrades(tape, [
      { price: 100, qty: 1, ts: now - 4000, makerSide: true },
      { price: 100, qty: 1, ts: now - 3000, makerSide: true },
      { price: 100, qty: 1, ts: now - 100, makerSide: true },
      { price: 100, qty: 1, ts: now, makerSide: true },
    ]);
    const result = tradeFlowExtended(tape, 5);
    expect(result.burstiness).toBeGreaterThan(0);
  });
});

describe('candleDerivedFeatures', () => {
  const makeCandles = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      open: 100 + i * 0.1,
      high: 100 + i * 0.1 + 0.5,
      low: 100 + i * 0.1 - 0.3,
      close: 100 + i * 0.15,
      volume: 1000 + i * 10,
    }));

  it('returns zeros for fewer than 3 candles', () => {
    const result = candleDerivedFeatures([], 20);
    expect(result.volumeZscore).toBe(0);
    expect(result.rangeExpansion).toBe(0);
    expect(result.trendSlope).toBe(0);
    expect(result.momentum).toBe(0);
  });

  it('computes volume zscore for the latest bar', () => {
    const candles = makeCandles(20);
    candles[19].volume = 3000;
    const result = candleDerivedFeatures(candles, 20);
    expect(result.volumeZscore).toBeGreaterThan(1);
  });

  it('computes range expansion relative to average', () => {
    const candles = makeCandles(20);
    candles[19].high = 200;
    candles[19].low = 100;
    const result = candleDerivedFeatures(candles, 20);
    expect(result.rangeExpansion).toBeGreaterThan(5);
  });

  it('computes positive momentum for upward series', () => {
    const candles = makeCandles(20);
    const result = candleDerivedFeatures(candles, 20);
    expect(result.momentum).toBeGreaterThan(0);
    expect(result.trendSlope).toBeGreaterThan(0);
  });
});

describe('DepthChangeTracker', () => {
  it('detects book thinning when depth decreases', () => {
    const tracker = new DepthChangeTracker(60_000, 5, 5);
    const fullBook = buildBook(
      [[100, 100], [99, 100], [98, 100]],
      [[101, 100], [102, 100], [103, 100]],
    );
    tracker.update(fullBook);

    const thinBook = buildBook(
      [[100, 10], [99, 10], [98, 10]],
      [[101, 10], [102, 10], [103, 10]],
    );
    tracker.update(thinBook);

    const snap = tracker.snapshot();
    expect(snap.bookThinning).toBeLessThan(0);
  });

  it('detects cancel intensity when levels disappear', () => {
    const tracker = new DepthChangeTracker(60_000, 5, 5);
    const fullBook = buildBook(
      [[100, 100], [99, 100], [98, 100]],
      [[101, 100], [102, 100], [103, 100]],
    );
    tracker.update(fullBook);

    const fewerLevels = buildBook(
      [[100, 100], [99, 100]],
      [[101, 100], [102, 100]],
    );
    tracker.update(fewerLevels);

    const snap = tracker.snapshot();
    expect(snap.cancelIntensity).toBeGreaterThan(0);
  });

  it('tracks wall persistence for large levels', () => {
    const tracker = new DepthChangeTracker(60_000, 2, 5);
    const wallBook = buildBook(
      [[100, 10], [99, 100]],
      [[101, 10], [102, 100]],
    );
    tracker.update(wallBook);
    tracker.update(wallBook);

    const snap = tracker.snapshot();
    expect(snap.bidWallPersistence).toBeGreaterThanOrEqual(0);
    expect(snap.askWallPersistence).toBeGreaterThanOrEqual(0);
  });
});
