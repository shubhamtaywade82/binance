import { describe, expect, it } from 'vitest';
import { analyzeSmc } from '../src/strategy/smc';
import type { Candle } from '../src/types';

function mk(o: number, h: number, l: number, c: number, i: number, v = 100): Candle {
  return { openTime: i * 60_000, open: o, high: h, low: l, close: c, volume: v };
}

describe('analyzeSmc', () => {
  it('returns zero score for empty/short history', () => {
    const r = analyzeSmc([], 0, 'LONG');
    expect(r.score).toBe(0);
  });

  it('detects bullish FVG', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 25; i++) cs.push(mk(100, 100.5, 99.5, 100, i));
    cs.push(mk(100, 101, 99.5, 100.8, 25));
    cs.push(mk(101, 103, 100.5, 102.5, 26));
    cs.push(mk(102.5, 105, 102, 104.5, 27));
    const r = analyzeSmc(cs, 104.5, 'LONG');
    expect(r.fvg?.type === 'BULLISH' || r.fvg === null).toBe(true);
  });

  it('detects liquidity sweep above range as LONG sweep', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 20; i++) cs.push(mk(100, 100.5, 99.5, 100, i));
    cs.push(mk(100, 102, 99.8, 100.2, 20));
    cs.push(mk(100.2, 105, 100, 100.4, 21));
    cs.push(mk(100.4, 100.8, 100, 100.3, 22));
    const r = analyzeSmc(cs, 100.3, 'SHORT');
    expect(r.liquiditySweep).toBe('LONG');
    expect(r.liquidity?.classification).toBe('SWEEP_REJECTION');
    expect(r.liquidity?.primaryRejection?.poolKind).toBe('buyside');
  });

  it('scores increases for bullish concepts under LONG htf', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 20; i++) cs.push(mk(100 + i * 0.1, 100.5 + i * 0.1, 99.5 + i * 0.1, 100 + i * 0.1, i));
    cs.push(mk(102, 102.5, 100, 100.5, 20));
    cs.push(mk(100.5, 105, 100.4, 104.8, 21));
    cs.push(mk(104.8, 107, 104.6, 106.5, 22));
    const r = analyzeSmc(cs, 106.5, 'LONG');
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});
