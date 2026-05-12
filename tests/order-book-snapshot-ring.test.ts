import { describe, expect, it } from 'vitest';
import { LocalOrderBook } from '../src/binance/orderbook';
import { OrderBookSnapshotRing, snapshotFromOrderBook } from '../src/liquidity/order-book-snapshot-ring';

describe('OrderBookSnapshotRing', () => {
  it('nearest returns snapshot within window', () => {
    const ring = new OrderBookSnapshotRing({ depthLevels: 5 });
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [
        [100, 1],
        [99, 2],
      ],
      asks: [
        [101, 1],
        [102, 1],
      ],
    });
    ring.recordFromBook('SOLUSDT', ob, 1_000_000);
    ring.recordFromBook('SOLUSDT', ob, 1_000_500);
    const hit = ring.nearest('SOLUSDT', 1_000_200, 400);
    expect(hit).not.toBeNull();
    expect(hit!.ts).toBe(1_000_000);
  });

  it('releaseAfterSweep removes entries near bar open (idempotent)', () => {
    const ring = new OrderBookSnapshotRing({ depthLevels: 5 });
    const ob = new LocalOrderBook();
    ob.bootstrap({
      lastUpdateId: 1,
      bids: [[100, 1]],
      asks: [[101, 1]],
    });
    ring.recordFromBook('X', ob, 10_000);
    ring.recordFromBook('X', ob, 12_000);
    ring.releaseAfterSweep('X', 11_000, 3000);
    expect(ring.nearest('X', 10_500, 500)).toBeNull();
    ring.releaseAfterSweep('X', 11_000, 3000);
  });
});

describe('snapshotFromOrderBook', () => {
  it('returns null when book not bootstrapped', () => {
    const ob = new LocalOrderBook();
    expect(snapshotFromOrderBook(ob, 10, Date.now())).toBeNull();
  });
});
