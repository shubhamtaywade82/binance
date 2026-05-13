import { describe, expect, it } from 'vitest';
import { AggTradeTape } from '../src/binance/trade-tape';
import { LocalOrderBook } from '../src/binance/orderbook';
import {
  tradeFlowImbalance,
  weightedObi,
  microprice,
  snapshotMicrostructure,
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
    expect(s.mid).not.toBeNull();
  });
});
