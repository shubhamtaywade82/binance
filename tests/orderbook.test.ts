import { describe, expect, it, vi } from 'vitest';
import { LocalOrderBook, type DepthDiff } from '../src/binance/orderbook';

const snap = (lastUpdateId: number) => ({
  lastUpdateId,
  bids: [['100', '1'], ['99', '2']] as [string, string][],
  asks: [['101', '1'], ['102', '2']] as [string, string][],
});

const diff = (U: number, u: number, bids: [string, string][] = [], asks: [string, string][] = []): DepthDiff => ({ U, u, bids, asks });

describe('LocalOrderBook', () => {
  it('bootstraps and reports top of book', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap(snap(100));
    expect(ob.bestBid()).toEqual({ price: 100, qty: 1 });
    expect(ob.bestAsk()).toEqual({ price: 101, qty: 1 });
    expect(ob.spread()).toBe(1);
    expect(ob.midPrice()).toBe(100.5);
  });

  it('drops buffered diffs with u <= lastUpdateId and applies valid first', () => {
    const ob = new LocalOrderBook();
    ob.buffer(diff(50, 80));
    ob.buffer(diff(99, 101, [['100', '5']]));
    ob.buffer(diff(102, 103, [['100', '7']]));
    ob.bootstrap(snap(100));
    expect(ob.bestBid()!.qty).toBe(7);
  });

  it('emits desync when first applied diff is out of range', () => {
    const ob = new LocalOrderBook();
    const onDesync = vi.fn();
    ob.setDesyncHandler(onDesync);
    ob.buffer(diff(200, 250));
    ob.bootstrap(snap(100));
    expect(onDesync).toHaveBeenCalled();
    expect(ob.isBootstrapped()).toBe(false);
  });

  it('detects gap during streaming diffs', () => {
    const ob = new LocalOrderBook();
    const onDesync = vi.fn();
    ob.setDesyncHandler(onDesync);
    ob.bootstrap(snap(100));
    ob.applyDiff(diff(101, 110));
    ob.applyDiff(diff(115, 120));
    expect(onDesync).toHaveBeenCalled();
  });

  it('top-N math returns sorted bids desc, asks asc', () => {
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [['100', '1'], ['99', '2'], ['98', '3']],
      asks: [['102', '1'], ['101', '2'], ['103', '3']],
    });
    const t = ob.topLevels(2);
    expect(t.bids.map((b) => b.price)).toEqual([100, 99]);
    expect(t.asks.map((a) => a.price)).toEqual([101, 102]);
  });
});
