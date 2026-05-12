import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/types';
import { alignedTrend, biasFromCandles, emaLast } from '../src/strategy/htf-ltf';

const candlesFromCloses = (closes: number[], start = 1_000_000): Candle[] => {
  return closes.map((close, i) => ({
    openTime: start + i * 60_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

describe('emaLast', () => {
  it('returns null until enough samples', () => {
    expect(emaLast([1, 2, 3], 5)).toBeNull();
  });

  it('computes a finite EMA', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    const v = emaLast(values, 9);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(100);
  });
});

describe('biasFromCandles', () => {
  it('returns NONE for short history', () => {
    expect(biasFromCandles(candlesFromCloses([1, 2, 3]))).toBe('NONE');
  });
});

describe('alignedTrend', () => {
  it('requires both timeframes to agree', () => {
    expect(alignedTrend('LONG', 'LONG')).toBe('LONG');
    expect(alignedTrend('SHORT', 'SHORT')).toBe('SHORT');
    expect(alignedTrend('LONG', 'SHORT')).toBe('NONE');
    expect(alignedTrend('NONE', 'LONG')).toBe('NONE');
  });
});
