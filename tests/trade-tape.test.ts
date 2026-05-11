import { describe, expect, it } from 'vitest';
import { AggTradeTape } from '../src/binance/trade-tape';

describe('AggTradeTape', () => {
  it('returns lastPrice and tracks count', () => {
    const t = new AggTradeTape(5);
    t.push({ price: 100, qty: 1, ts: 1000, makerSide: false });
    t.push({ price: 101, qty: 2, ts: 2000, makerSide: true });
    expect(t.lastPrice()).toBe(101);
    expect(t.count()).toBe(2);
  });

  it('evicts oldest when capacity exceeded (ring buffer)', () => {
    const t = new AggTradeTape(3);
    for (let i = 0; i < 5; i += 1) {
      t.push({ price: i, qty: 1, ts: i * 1000, makerSide: false });
    }
    expect(t.count()).toBe(3);
    expect(t.lastPrice()).toBe(4);
    expect(t.recent(10).length).toBe(3);
  });

  it('vwap respects time window', () => {
    const t = new AggTradeTape(10);
    t.push({ price: 100, qty: 1, ts: 1000, makerSide: false });
    t.push({ price: 200, qty: 1, ts: 5000, makerSide: false });
    t.push({ price: 300, qty: 2, ts: 9000, makerSide: false });
    expect(t.vwapOver(5)).toBe((200 * 1 + 300 * 2) / 3);
    expect(t.vwapOver(0.001)).toBe(300);
    expect(t.volumeOver(5)).toBe(3);
  });

  it('returns null vwap when empty', () => {
    const t = new AggTradeTape();
    expect(t.vwapOver(60)).toBeNull();
    expect(t.lastPrice()).toBeNull();
  });
});
