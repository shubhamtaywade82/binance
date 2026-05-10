import { describe, expect, it } from 'vitest';
import {
  ema,
  emaSeries,
  rsi,
  macd,
  atr,
  supertrend,
  swingHighsLows,
  swingStructure,
  volumeConfirms,
} from '../src/strategy/indicators';
import type { Candle } from '../src/types';

function mkCandles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * 60_000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100,
  }));
}

describe('ema', () => {
  it('returns NaN until period reached, then numeric', () => {
    const v = ema([1, 2, 3, 4, 5], 3);
    expect(Number.isNaN(v[0])).toBe(true);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBeCloseTo(2, 5);
    expect(v[3]).toBeCloseTo(3, 5);
  });

  it('emaSeries is alias of ema', () => {
    const a = ema([1, 2, 3, 4, 5, 6, 7], 3);
    const b = emaSeries([1, 2, 3, 4, 5, 6, 7], 3);
    expect(a).toEqual(b);
  });

  it('rising series produces rising EMA', () => {
    const v = ema(Array.from({ length: 30 }, (_, i) => i + 1), 9);
    const last = v[v.length - 1];
    const mid = v[15];
    expect(last).toBeGreaterThan(mid);
  });
});

describe('rsi', () => {
  it('returns 100 for monotonically rising prices', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const r = rsi(closes, 14);
    expect(r[r.length - 1]).toBe(100);
  });

  it('returns ~0 for monotonically falling prices', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
    const r = rsi(closes, 14);
    expect(r[r.length - 1]).toBeLessThan(5);
  });
});

describe('macd', () => {
  it('produces matching length series', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3));
    const m = macd(closes);
    expect(m.macd.length).toBe(60);
    expect(m.signal.length).toBe(60);
    expect(m.hist.length).toBe(60);
    const last = m.hist[m.hist.length - 1];
    expect(Number.isFinite(last)).toBe(true);
  });
});

describe('atr', () => {
  it('matches a simple constant range fixture', () => {
    const candles: Candle[] = Array.from({ length: 20 }, (_, i) => ({
      openTime: i * 60_000,
      open: 100,
      high: 102,
      low: 98,
      close: 100,
      volume: 1,
    }));
    const a = atr(candles, 14);
    expect(a[a.length - 1]).toBeCloseTo(4, 5);
  });
});

describe('supertrend', () => {
  it('flips direction with trend reversal', () => {
    const up = mkCandles(Array.from({ length: 30 }, (_, i) => 100 + i));
    const down = mkCandles(Array.from({ length: 30 }, (_, i) => 130 - i));
    const stUp = supertrend(up).dir;
    const stDown = supertrend(down).dir;
    expect(stUp[stUp.length - 1]).toBe('LONG');
    expect(stDown[stDown.length - 1]).toBe('SHORT');
  });
});

describe('swingHighsLows', () => {
  it('finds local pivots', () => {
    const closes = [10, 11, 12, 11, 10, 9, 10, 11, 12, 13, 12, 11];
    const cs = mkCandles(closes);
    const sw = swingHighsLows(cs, 2);
    expect(sw.highs.length + sw.lows.length).toBeGreaterThan(0);
  });
});

describe('swingStructure', () => {
  it('detects HH/HL on uptrend', () => {
    const cs = mkCandles(Array.from({ length: 30 }, (_, i) => 100 + i));
    const s = swingStructure(cs, 10);
    expect(s.hh).toBe(true);
    expect(s.hl).toBe(true);
  });
});

describe('volumeConfirms', () => {
  it('true when last vol >= threshold * avg', () => {
    const cs = mkCandles(Array.from({ length: 25 }, () => 100));
    cs[cs.length - 1].volume = 200;
    expect(volumeConfirms(cs, 20, 0.8)).toBe(true);
  });
});
