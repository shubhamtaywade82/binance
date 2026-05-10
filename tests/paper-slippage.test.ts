import { describe, expect, it } from 'vitest';
import { SlippageEngine } from '../src/execution/paper/slippage';

describe('SlippageEngine', () => {
  it('computes the documented formula', () => {
    const v = SlippageEngine.priceImpactUsdt({
      side: 'LONG',
      quantity: 100,
      spread: 0.4,
      volatilityPct: 0.2,
      baseSlippageBps: 5,
    });
    const expected = 0.4 * 0.5 + 0.2 * 0.15 + 100 * 0.00001 + 5 / 10_000;
    expect(v).toBeCloseTo(expected, 12);
  });

  it('is monotonic in spread', () => {
    const a = SlippageEngine.priceImpactUsdt({ side: 'LONG', quantity: 1, spread: 0.1, volatilityPct: 0, baseSlippageBps: 0 });
    const b = SlippageEngine.priceImpactUsdt({ side: 'LONG', quantity: 1, spread: 0.5, volatilityPct: 0, baseSlippageBps: 0 });
    expect(b).toBeGreaterThan(a);
  });

  it('is monotonic in volatility', () => {
    const a = SlippageEngine.priceImpactUsdt({ side: 'LONG', quantity: 1, spread: 0, volatilityPct: 0.1, baseSlippageBps: 0 });
    const b = SlippageEngine.priceImpactUsdt({ side: 'LONG', quantity: 1, spread: 0, volatilityPct: 1, baseSlippageBps: 0 });
    expect(b).toBeGreaterThan(a);
  });

  it('is monotonic in quantity', () => {
    const a = SlippageEngine.priceImpactUsdt({ side: 'SHORT', quantity: 10, spread: 0, volatilityPct: 0, baseSlippageBps: 1 });
    const b = SlippageEngine.priceImpactUsdt({ side: 'SHORT', quantity: 1000, spread: 0, volatilityPct: 0, baseSlippageBps: 1 });
    expect(b).toBeGreaterThan(a);
  });
});
