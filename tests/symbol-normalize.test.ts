import { describe, expect, it } from 'vitest';
import { normalizeSymbol } from '../src/mapping/symbol-normalize';

describe('normalizeSymbol', () => {
  it('strips the CoinDCX B- prefix and _ separator', () => {
    expect(normalizeSymbol('B-SOL_USDT')).toBe('SOLUSDT');
    expect(normalizeSymbol('B-ETH_USDT')).toBe('ETHUSDT');
    expect(normalizeSymbol('B-BTC_USDT')).toBe('BTCUSDT');
  });

  it('is case-insensitive on the prefix and output is upper', () => {
    expect(normalizeSymbol('b-sol_usdt')).toBe('SOLUSDT');
    expect(normalizeSymbol('B-Sol_Usdt')).toBe('SOLUSDT');
  });

  it('passes through Binance-style symbols unchanged (modulo case)', () => {
    expect(normalizeSymbol('SOLUSDT')).toBe('SOLUSDT');
    expect(normalizeSymbol('solusdt')).toBe('SOLUSDT');
  });

  it('handles SOL_USDT without the B- prefix', () => {
    expect(normalizeSymbol('SOL_USDT')).toBe('SOLUSDT');
  });

  it('handles leading/trailing whitespace', () => {
    expect(normalizeSymbol('  SOLUSDT  ')).toBe('SOLUSDT');
    expect(normalizeSymbol('\tB-SOL_USDT\n')).toBe('SOLUSDT');
  });

  it('handles digit-prefixed token names (1000PEPE)', () => {
    expect(normalizeSymbol('1000PEPE_USDT')).toBe('1000PEPEUSDT');
    expect(normalizeSymbol('B-1000PEPE_USDT')).toBe('1000PEPEUSDT');
  });

  it('returns empty string for nullish or empty inputs', () => {
    expect(normalizeSymbol('')).toBe('');
    expect(normalizeSymbol('   ')).toBe('');
    expect(normalizeSymbol(null)).toBe('');
    expect(normalizeSymbol(undefined)).toBe('');
  });

  it('is idempotent', () => {
    const inputs = ['SOLUSDT', 'B-SOL_USDT', 'solusdt', '1000PEPEUSDT'];
    for (const i of inputs) {
      const once = normalizeSymbol(i);
      const twice = normalizeSymbol(once);
      expect(once).toBe(twice);
    }
  });
});
