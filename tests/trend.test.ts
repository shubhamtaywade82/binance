import { describe, expect, it } from 'vitest';
import { analyzeTrend } from '../src/strategy/trend';
import type { Candle } from '../src/types';

const candles = (closes: number[], vols?: number[]): Candle[] => {
  return closes.map((c, i) => ({
    openTime: i * 60_000,
    open: i === 0 ? c : closes[i - 1],
    high: c + 0.3,
    low: c - 0.3,
    close: c,
    volume: vols?.[i] ?? 100,
  }));
}

describe('analyzeTrend', () => {
  it('returns NONE for short history', () => {
    const r = analyzeTrend(candles([1, 2, 3]));
    expect(r.direction).toBe('NONE');
    expect(r.confidence).toBe(0);
  });

  it('detects uptrend with sufficient confidence', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + Math.sin(i / 2) * 0.1);
    const vols = Array.from({ length: 80 }, () => 100);
    vols[vols.length - 1] = 200;
    const r = analyzeTrend(candles(closes, vols));
    expect(r.direction).toBe('LONG');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('detects downtrend', () => {
    const closes: number[] = [];
    let p = 200;
    for (let i = 0; i < 60; i++) {
      p += i % 3 === 0 ? 0.2 : -0.6;
      closes.push(p);
    }
    for (let i = 0; i < 20; i++) {
      p += i % 3 === 0 ? 0.3 : -1.4;
      closes.push(p);
    }
    const vols = Array.from({ length: 80 }, () => 100);
    vols[vols.length - 1] = 200;
    const r = analyzeTrend(candles(closes, vols));
    expect(r.direction).toBe('SHORT');
  });

  it('returns NONE for choppy data', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i) * 0.5);
    const r = analyzeTrend(candles(closes));
    expect(r.direction).toBe('NONE');
  });
});
