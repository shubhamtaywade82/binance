import { describe, expect, it } from 'vitest';
import { aggregateAsks, aggregateBids, ceilToTick, defaultTickChoices, floorToTick } from '../ui/book-aggregate.js';

describe('book-aggregate', () => {
  it('floors bid prices to tick', () => {
    expect(floorToTick(96.179, 0.01)).toBeCloseTo(96.17, 8);
    expect(floorToTick(96.17, 0.01)).toBeCloseTo(96.17, 8);
  });

  it('ceils ask prices to tick', () => {
    expect(ceilToTick(96.171, 0.01)).toBeCloseTo(96.18, 8);
    expect(ceilToTick(96.18, 0.01)).toBeCloseTo(96.18, 8);
  });

  it('merges bid levels into the same bucket', () => {
    const bids = [
      { price: 100.02, qty: 1 },
      { price: 100.01, qty: 2 },
      { price: 100.015, qty: 3 },
    ];
    const out = aggregateBids(bids, 0.01);
    expect(out.find((l) => l.price === 100.02)?.qty).toBe(1);
    expect(out.find((l) => l.price === 100.01)?.qty).toBe(5);
    expect(out[0].price).toBeGreaterThan(out[1].price);
  });

  it('merges ask levels into the same bucket', () => {
    const asks = [
      { price: 100.18, qty: 1 },
      { price: 100.19, qty: 2 },
      { price: 100.181, qty: 4 },
    ];
    const out = aggregateAsks(asks, 0.01);
    expect(out.find((l) => l.price === 100.18)?.qty).toBe(1);
    expect(out.find((l) => l.price === 100.19)?.qty).toBe(6);
    expect(out[0].price).toBeLessThan(out[1].price);
  });

  it('defaultTickChoices returns descending ticks with labels', () => {
    const c = defaultTickChoices(96);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0].tick).toBeGreaterThanOrEqual(c[c.length - 1].tick);
    expect(c.some((x) => x.tick === 0.01)).toBe(true);
  });
});
