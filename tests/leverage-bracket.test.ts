import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import {
  getLeverageBracket,
  bracketForNotional,
  validateNotionalAgainstBracket,
  type LeverageBracketTier,
} from '../src/binance/rest-trade';

const tiers: LeverageBracketTier[] = [
  { bracket: 1, initialLeverage: 75, notionalCap: 10000, notionalFloor: 0, maintMarginRatio: 0.0065, cum: 0 },
  { bracket: 2, initialLeverage: 50, notionalCap: 50000, notionalFloor: 10000, maintMarginRatio: 0.01, cum: 35 },
  { bracket: 3, initialLeverage: 25, notionalCap: 250000, notionalFloor: 50000, maintMarginRatio: 0.02, cum: 535 },
];

describe('getLeverageBracket', () => {
  it('calls signed GET and wraps single-object response into array', async () => {
    const signedGet = vi.fn().mockResolvedValue({
      symbol: 'SOLUSDT',
      brackets: tiers,
    });
    const client = { signedGet } as unknown as BinanceRestClient;
    const result = await getLeverageBracket(client, 'solusdt');
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/leverageBracket', { symbol: 'SOLUSDT' });
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('SOLUSDT');
    expect(result[0].brackets).toHaveLength(3);
  });

  it('passes through array response unchanged', async () => {
    const signedGet = vi.fn().mockResolvedValue([
      { symbol: 'BTCUSDT', brackets: tiers },
      { symbol: 'ETHUSDT', brackets: tiers },
    ]);
    const client = { signedGet } as unknown as BinanceRestClient;
    const result = await getLeverageBracket(client);
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/leverageBracket', {});
    expect(result).toHaveLength(2);
  });
});

describe('bracketForNotional', () => {
  it('returns tier 1 for small notional', () => {
    const tier = bracketForNotional(tiers, 5000);
    expect(tier?.bracket).toBe(1);
    expect(tier?.initialLeverage).toBe(75);
  });

  it('returns tier 2 for mid-range notional', () => {
    const tier = bracketForNotional(tiers, 30000);
    expect(tier?.bracket).toBe(2);
    expect(tier?.initialLeverage).toBe(50);
  });

  it('returns highest tier for large notional', () => {
    const tier = bracketForNotional(tiers, 100000);
    expect(tier?.bracket).toBe(3);
  });

  it('returns tier 1 for zero notional', () => {
    const tier = bracketForNotional(tiers, 0);
    expect(tier?.bracket).toBe(1);
  });

  it('returns null for empty brackets', () => {
    expect(bracketForNotional([], 1000)).toBeNull();
  });
});

describe('validateNotionalAgainstBracket', () => {
  it('passes when leverage and notional within tier limits', () => {
    const r = validateNotionalAgainstBracket(tiers, 5000, 50);
    expect(r.ok).toBe(true);
    expect(r.maxLeverage).toBe(75);
    expect(r.maxNotional).toBe(10000);
  });

  it('fails when leverage exceeds tier max', () => {
    const r = validateNotionalAgainstBracket(tiers, 30000, 75);
    expect(r.ok).toBe(false);
    expect(r.maxLeverage).toBe(50);
  });

  it('fails when notional exceeds tier cap', () => {
    const r = validateNotionalAgainstBracket(tiers, 300000, 10);
    expect(r.ok).toBe(false);
  });
});
