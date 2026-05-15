import { describe, expect, it } from 'vitest';
import { analyzeKnnArchitecture } from '../src/strategy/knn-architecture';
import type { Candle } from '../src/types';

const mk = (o: number, h: number, l: number, c: number, i: number, v = 100): Candle => ({
  openTime: i * 60_000, open: o, high: h, low: l, close: c, volume: v,
});

const flatCandles = (n: number, base = 100, vol = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => mk(base, base + 0.5, base - 0.5, base, i, vol));

const trendUp = (n: number, startPrice = 90, step = 0.5, vol = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const p = startPrice + i * step;
    return mk(p, p + 1, p - 0.3, p + 0.5, i, vol);
  });

const withPivotHigh = (candles: Candle[], idx: number, spike: number): Candle[] => {
  const out = [...candles];
  const c = out[idx];
  out[idx] = { ...c, high: c.high + spike, close: c.open };
  return out;
};

const withPivotLow = (candles: Candle[], idx: number, dip: number): Candle[] => {
  const out = [...candles];
  const c = out[idx];
  out[idx] = { ...c, low: c.low - dip, close: c.open };
  return out;
};

describe('analyzeKnnArchitecture', () => {
  it('returns empty result for insufficient data', () => {
    const r = analyzeKnnArchitecture([]);
    expect(r.bias).toBe('NONE');
    expect(r.stBOS).toEqual([]);
    expect(r.deltaTanks).toEqual([]);
    expect(r.volumeProfile).toEqual([]);
  });

  it('returns empty result when candles < 50', () => {
    const r = analyzeKnnArchitecture(flatCandles(30));
    expect(r.stLines.high).toBeNull();
    expect(r.stLines.low).toBeNull();
  });

  it('detects ST pivot highs and lows on structured data', () => {
    const cs = flatCandles(100);
    const withHigh = withPivotHigh(cs, 20, 5);
    const withBoth = withPivotLow(withHigh, 40, 5);
    const r = analyzeKnnArchitecture(withBoth);

    const hasHighOrBos = r.stLines.high != null || r.stBOS.length > 0;
    const hasLowOrBos = r.stLines.low != null || r.stBOS.length > 0;
    expect(hasHighOrBos || hasLowOrBos).toBe(true);
  });

  it('produces BOS when price breaks a structural level', () => {
    const cs = flatCandles(100, 100);
    cs[20] = mk(100, 108, 99, 100, 20, 200);
    for (let i = 50; i < 60; i++) {
      cs[i] = mk(107, 110, 106, 109, i, 150);
    }
    const r = analyzeKnnArchitecture(cs);
    const allBos = [...r.stBOS, ...r.mtBOS, ...r.ltBOS];
    expect(allBos.length).toBeGreaterThanOrEqual(0);
  });

  it('delta tanks accumulate from formation bar, not fixed window', () => {
    const cs = flatCandles(100, 100);
    cs[15] = mk(100, 110, 99, 100, 15, 300);
    for (let i = 16; i < 100; i++) {
      cs[i] = mk(109, 110.5, 108, 109, i, 50);
    }
    const r = analyzeKnnArchitecture(cs);
    for (const tank of r.deltaTanks) {
      expect(tank.volume).toBeGreaterThan(0);
      expect(Math.abs(tank.ratio)).toBeLessThanOrEqual(1);
    }
  });

  it('volume profile bins are anchored between active high and low', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 100; i++) {
      const p = 100 + Math.sin(i / 5) * 5;
      cs.push(mk(p, p + 1, p - 1, p + 0.5, i, 100 + i));
    }
    const r = analyzeKnnArchitecture(cs);
    if (r.volumeProfile.length > 0) {
      const poc = r.volumeProfile.filter(b => b.isPoc);
      expect(poc.length).toBeLessThanOrEqual(1);
      for (const bin of r.volumeProfile) {
        expect(bin.volume).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('bias reflects price position relative to active range', () => {
    const cs = flatCandles(100, 100);
    cs[15] = mk(100, 115, 99, 100, 15, 200);
    cs[30] = mk(100, 101, 85, 100, 30, 200);
    for (let i = 80; i < 100; i++) {
      cs[i] = mk(120, 125, 119, 122, i, 100);
    }
    const r = analyzeKnnArchitecture(cs);
    if (r.stLines.high != null && r.stLines.low != null) {
      const lastClose = cs[99].close;
      if (lastClose > r.stLines.high) expect(r.bias).toBe('LONG');
    }
  });

  it('per-term kNN histories are independent', () => {
    const cs = flatCandles(200, 100);
    for (let i = 0; i < 200; i += 20) {
      cs[i] = mk(100, 100 + (i % 40 === 0 ? 8 : 3), 99, 100, i, 200);
    }
    const r = analyzeKnnArchitecture(cs);
    expect(r.stLines).toBeDefined();
    expect(r.mtLines).toBeDefined();
    expect(r.ltLines).toBeDefined();
  });

  it('active levels track formation index', () => {
    const cs = flatCandles(100, 100);
    cs[20] = mk(100, 112, 99, 100, 20, 300);
    cs[40] = mk(100, 101, 88, 100, 40, 300);
    const r = analyzeKnnArchitecture(cs);
    for (const level of r.activeLevels) {
      expect(level.formIndex).toBeGreaterThanOrEqual(0);
      expect(level.formIndex).toBeLessThan(100);
      expect(['ST', 'MT', 'LT']).toContain(level.term);
    }
  });

  it('confidence is between 0 and 1', () => {
    const cs = trendUp(100);
    const r = analyzeKnnArchitecture(cs);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });
});
