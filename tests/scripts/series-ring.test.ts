import { describe, expect, it } from 'vitest';
import { Series } from '@coindcx/indicator-runtime';

describe('Series ring buffer', () => {
  it('returns NaN for unfilled lookback', () => {
    const s = new Series(8);
    expect(Number.isNaN(s.get(0))).toBe(true);
    s.push(1);
    expect(s.get(0)).toBe(1);
    expect(Number.isNaN(s.get(1))).toBe(true);
  });

  it('overwrites oldest values once filled', () => {
    const cap = 5;
    const s = new Series(cap);
    for (let i = 1; i <= 10; i++) s.push(i);
    expect(s.length()).toBe(cap);
    // newest is 10, then 9, 8, 7, 6.
    expect(s.get(0)).toBe(10);
    expect(s.get(1)).toBe(9);
    expect(s.get(4)).toBe(6);
    expect(Number.isNaN(s.get(5))).toBe(true);
  });

  it('coerces non-finite pushes to NaN', () => {
    const s = new Series(4);
    s.push(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(s.get(0))).toBe(true);
  });

  it('rejects invalid capacities', () => {
    expect(() => new Series(0)).toThrow();
    expect(() => new Series(1.5 as any)).toThrow();
  });

  it('returns NaN for negative or non-finite barsAgo', () => {
    const s = new Series(4);
    s.push(1);
    expect(Number.isNaN(s.get(-1))).toBe(true);
    expect(Number.isNaN(s.get(Number.NaN))).toBe(true);
  });
});
