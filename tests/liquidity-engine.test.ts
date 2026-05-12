import { describe, expect, it } from 'vitest';
import { runLiquidityEngine } from '../src/strategy/liquidity-engine';
import type { Candle } from '../src/types';

function mk(o: number, h: number, l: number, c: number, i: number, v = 100): Candle {
  return { openTime: i * 60_000, open: o, high: h, low: l, close: c, volume: v };
}

describe('runLiquidityEngine', () => {
  it('returns empty when history is shorter than engine minimum', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 10; i++) cs.push(mk(100, 100.5, 99.5, 100, i));
    const r = runLiquidityEngine(cs, '5m', {});
    expect(r.pools).toHaveLength(0);
    expect(r.liquiditySweep).toBe('NONE');
  });

  it('classifies buyside raid with close back below range as sweep rejection', () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 20; i++) cs.push(mk(100, 100.5, 99.5, 100, i));
    cs.push(mk(100, 102, 99.8, 100.2, 20));
    cs.push(mk(100.2, 105, 100, 100.4, 21));
    cs.push(mk(100.4, 100.8, 100, 100.3, 22));
    const r = runLiquidityEngine(cs, '5m', {});
    expect(r.classification).toBe('SWEEP_REJECTION');
    expect(r.liquiditySweep).toBe('LONG');
    expect(r.primaryRejection?.outcome).toBe('rejection');
    expect(r.primaryRejection?.poolKind).toBe('buyside');
    expect(r.sweepQualityScore).toBeGreaterThanOrEqual(3);
  });
});
