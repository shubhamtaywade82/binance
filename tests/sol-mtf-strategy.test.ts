import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/types';
import { evaluateSolMtfStrategy } from '../src/strategy/sol-mtf-strategy';

const mkTrend = (n: number, step = 0.3): Candle[] => {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const close = p + step * i;
    out.push({
      openTime: i * 60_000,
      open: close - step,
      high: close + 0.2,
      low: close - 0.2,
      close,
      volume: 150,
    });
    p = close;
  }
  return out;
}

const emptyMtf = (over: Partial<Record<'1d' | '4h' | '1h' | '15m' | '5m', Candle[]>> = {}) => {
  const base = {
    '1d': [] as Candle[],
    '4h': [] as Candle[],
    '1h': [] as Candle[],
    '15m': [] as Candle[],
    '5m': [] as Candle[],
  };
  return { ...base, ...over };
}

describe('evaluateSolMtfStrategy', () => {
  it('fails when daily series has insufficient bars', () => {
    const r = evaluateSolMtfStrategy({
      candles: emptyMtf({ '1d': mkTrend(10) }),
      refPrice: 100,
      minConfidence: 0.65,
    });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('daily_insufficient_bars');
  });

  it('fails when MTF windows are not seeded', () => {
    const r = evaluateSolMtfStrategy({
      candles: emptyMtf({ '1d': mkTrend(30) }),
      refPrice: 100,
      minConfidence: 0.65,
    });
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('mtf_insufficient_bars');
  });
});
