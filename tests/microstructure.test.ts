import { describe, expect, it } from 'vitest';
import { AggTradeTape } from '../src/binance/trade-tape';
import { LocalOrderBook } from '../src/binance/orderbook';
import {
  tradeFlowImbalance,
  weightedObi,
  microprice,
  depthPressure,
  createOfiTracker,
  updateOfi,
  rollingRealizedVol,
  spreadBps,
  snapshotMicrostructure,
  tradesToOhlcvBars,
  ohlcvBarsChronological,
  microBarCloseRet,
  microOhlcvBarsFromTape,
} from '../src/binance/microstructure';

const buildTape = (): AggTradeTape => {
  const tape = new AggTradeTape(100);
  const now = Date.now();
  tape.push({ price: 100, qty: 5, ts: now - 800, makerSide: true });
  tape.push({ price: 100.1, qty: 3, ts: now - 600, makerSide: false });
  tape.push({ price: 100.2, qty: 2, ts: now - 200, makerSide: true });
  return tape;
};

const buildBook = (): LocalOrderBook => {
  const ob = new LocalOrderBook();
  ob.bootstrap({
    lastUpdateId: 1,
    bids: [['100', '10'], ['99', '20'], ['98', '30'], ['97', '40'], ['96', '50']],
    asks: [['101', '5'], ['102', '15'], ['103', '25'], ['104', '35'], ['105', '45']],
  });
  return ob;
};

describe('tradeFlowImbalance', () => {
  it('splits buy/sell volume by makerSide flag', () => {
    const tape = buildTape();
    const r = tradeFlowImbalance(tape, 60);
    expect(r.buyVol).toBe(7);
    expect(r.sellVol).toBe(3);
    expect(r.tfi).toBe(4);
    expect(r.tradeCount).toBe(3);
  });

  it('returns zeros on empty tape', () => {
    const tape = new AggTradeTape(10);
    const r = tradeFlowImbalance(tape, 1);
    expect(r.tfi).toBe(0);
    expect(r.tradeCount).toBe(0);
  });
});

describe('weightedObi', () => {
  it('weights closer levels more than distant levels', () => {
    const ob = buildBook();
    const r5 = weightedObi(ob, 5);
    expect(r5.weightedObi).toBeGreaterThan(0);
    expect(r5.bidWeightedVol).toBeGreaterThan(0);
    expect(r5.askWeightedVol).toBeGreaterThan(0);
  });

  it('returns 0 on empty book', () => {
    const ob = new LocalOrderBook();
    const r = weightedObi(ob, 5);
    expect(r.weightedObi).toBe(0);
  });

  it('reflects bid-heavy vs ask-heavy asymmetry', () => {
    const bidHeavy = new LocalOrderBook();
    bidHeavy.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '100']],
      asks: [['101', '1']],
    });
    const askHeavy = new LocalOrderBook();
    askHeavy.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '1']],
      asks: [['101', '100']],
    });
    expect(weightedObi(bidHeavy, 1).weightedObi).toBeGreaterThan(0.5);
    expect(weightedObi(askHeavy, 1).weightedObi).toBeLessThan(-0.5);
  });
});

describe('microprice', () => {
  it('computes volume-weighted mid', () => {
    const ob = buildBook();
    const mp = microprice(ob);
    expect(mp).not.toBeNull();
    const bid = ob.bestBid()!;
    const ask = ob.bestAsk()!;
    const expected = (ask.price * bid.qty + bid.price * ask.qty) / (bid.qty + ask.qty);
    expect(mp).toBeCloseTo(expected, 8);
  });

  it('skews toward the heavier side', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '100']],
      asks: [['102', '1']],
    });
    const mp = microprice(ob)!;
    const mid = 101;
    expect(mp).toBeGreaterThan(mid);
    expect(mp).toBeLessThan(102);
  });

  it('returns null on empty book', () => {
    expect(microprice(new LocalOrderBook())).toBeNull();
  });
});

describe('depthPressure', () => {
  it('returns positive pressure when bid side has more volume per distance', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [['99', '100']],
      asks: [['101', '10']],
    });
    const r = depthPressure(ob, 1);
    expect(r.bidPressure).toBeGreaterThan(r.askPressure);
    expect(r.depthPressure).toBeGreaterThan(0);
  });

  it('returns zeros on empty book', () => {
    const r = depthPressure(new LocalOrderBook(), 5);
    expect(r.depthPressure).toBe(0);
  });
});

describe('OFI tracker', () => {
  it('detects positive OFI when bid size increases', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '10']],
      asks: [['101', '10']],
    });
    const tracker = createOfiTracker();
    const initial = updateOfi(tracker, ob);
    const cumulativeAfterInit = tracker.cumulativeOfi;

    ob.applyDiff({ U: 2, u: 2, bids: [['100', '20']], asks: [] });
    const delta = updateOfi(tracker, ob);
    expect(delta).toBe(10);
    expect(tracker.cumulativeOfi).toBe(cumulativeAfterInit + 10);
  });

  it('detects negative OFI when ask size increases', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '10']],
      asks: [['101', '10']],
    });
    const tracker = createOfiTracker();
    updateOfi(tracker, ob);

    ob.applyDiff({ U: 2, u: 2, bids: [], asks: [['101', '20']] });
    const delta = updateOfi(tracker, ob);
    expect(delta).toBe(-10);
  });

  it('handles bid price change (new level)', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '10']],
      asks: [['101', '10']],
    });
    const tracker = createOfiTracker();
    updateOfi(tracker, ob);

    ob.applyDiff({ U: 2, u: 2, bids: [['100.5', '15']], asks: [] });
    const delta = updateOfi(tracker, ob);
    expect(delta).toBe(15);
  });
});

describe('rollingRealizedVol', () => {
  it('computes non-zero volatility from varying prices', () => {
    const tape = new AggTradeTape(100);
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      tape.push({ price: 100 + Math.sin(i) * 0.5, qty: 1, ts: now - (20 - i) * 50, makerSide: true });
    }
    const rv = rollingRealizedVol(tape, 5);
    expect(rv.rv).toBeGreaterThan(0);
    expect(rv.sampleCount).toBe(19);
  });

  it('returns zero for constant price', () => {
    const tape = new AggTradeTape(100);
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      tape.push({ price: 100, qty: 1, ts: now - (10 - i) * 50, makerSide: true });
    }
    const rv = rollingRealizedVol(tape, 5);
    expect(rv.rv).toBe(0);
  });

  it('returns zero for insufficient data', () => {
    const tape = new AggTradeTape(100);
    tape.push({ price: 100, qty: 1, ts: Date.now(), makerSide: true });
    const rv = rollingRealizedVol(tape, 5);
    expect(rv.rv).toBe(0);
    expect(rv.sampleCount).toBe(0);
  });
});

describe('spreadBps', () => {
  it('computes spread in basis points', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '10']],
      asks: [['101', '10']],
    });
    const bps = spreadBps(ob);
    expect(bps).toBeCloseTo(99.50, 0);
  });

  it('returns null on empty book', () => {
    expect(spreadBps(new LocalOrderBook())).toBeNull();
  });
});

describe('snapshotMicrostructure', () => {
  it('assembles all features in one call', () => {
    const s = snapshotMicrostructure(buildTape(), buildBook());
    expect(s.tfi1s).toBeDefined();
    expect(s.tfi5s).toBeDefined();
    expect(s.tfi30s).toBeDefined();
    expect(s.weightedObi5).toBeDefined();
    expect(s.weightedObi10).toBeDefined();
    expect(s.microprice).not.toBeNull();
    expect(s.spread).not.toBeNull();
    expect(s.spreadBps).not.toBeNull();
    expect(s.mid).not.toBeNull();
    expect(s.depthPressure10).toBeDefined();
    expect(s.rv1s).toBeDefined();
    expect(s.rv5s).toBeDefined();
    expect(s.rv1m).toBeDefined();
    expect(Array.isArray(s.microBars1s)).toBe(true);
    expect(Array.isArray(s.microBars5s)).toBe(true);
  });
});

describe('tradesToOhlcvBars', () => {
  it('builds OHLCV for trades in the same 1s bucket', () => {
    const t0 = 1_700_000_000_000;
    const bucket = Math.floor(t0 / 1000) * 1000;
    const trades = [
      { price: 100, qty: 1, ts: bucket + 100, makerSide: true },
      { price: 101, qty: 2, ts: bucket + 500, makerSide: false },
    ];
    const bars = ohlcvBarsChronological(tradesToOhlcvBars(trades, 1000));
    expect(bars).toHaveLength(1);
    expect(bars[0].o).toBe(100);
    expect(bars[0].c).toBe(101);
    expect(bars[0].h).toBe(101);
    expect(bars[0].l).toBe(100);
    expect(bars[0].v).toBe(3);
    expect(bars[0].buyV).toBe(1);
    expect(bars[0].sellV).toBe(2);
  });

  it('computes close-to-close return on last two bars', () => {
    const bars = [
      { t: 0, o: 10, h: 10, l: 10, c: 10, v: 1, buyV: 1, sellV: 0, n: 1 },
      { t: 1000, o: 11, h: 12, l: 11, c: 12, v: 2, buyV: 2, sellV: 0, n: 1 },
    ];
    expect(microBarCloseRet(bars)).toBeCloseTo(Math.log(1.2), 6);
  });
});

describe('microOhlcvBarsFromTape', () => {
  it('returns 1s and 5s bar arrays from tape', () => {
    const tape = new AggTradeTape(50);
    const now = Date.now();
    tape.push({ price: 50, qty: 1, ts: now - 2500, makerSide: true });
    tape.push({ price: 51, qty: 1, ts: now - 1500, makerSide: false });
    const { bars1s, bars5s } = microOhlcvBarsFromTape(tape, 30);
    expect(bars1s.length).toBeGreaterThanOrEqual(1);
    expect(bars5s.length).toBeGreaterThanOrEqual(1);
  });
});
