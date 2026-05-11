import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/types';
import { evaluateSmcConfluence } from '../src/strategy/smc-confluence';

function mk(up = true, n = 60): Candle[] {
  const out: Candle[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const d = up ? 0.2 : -0.2;
    const o = p;
    const c = p + d;
    out.push({ openTime: i * 60_000, open: o, high: Math.max(o, c) + 0.1, low: Math.min(o, c) - 0.1, close: c, volume: 100 });
    p = c;
  }
  return out;
}

describe('evaluateSmcConfluence', () => {
  it('returns disabled pass when feature off', () => {
    const res = evaluateSmcConfluence(mk(true), mk(true), 'LONG', 100, {
      enabled: false, mode: 'standard', standardMinScore: 3, sniperMinScore: 4, targetPct: 0.015,
    });
    expect(res.pass).toBe(true);
  });

  it('fails with no bias', () => {
    const res = evaluateSmcConfluence(mk(true), mk(true), 'NONE', 100, {
      enabled: true, mode: 'standard', standardMinScore: 3, sniperMinScore: 4, targetPct: 0.015,
    });
    expect(res.pass).toBe(false);
    expect(res.direction).toBe('NONE');
  });
});
