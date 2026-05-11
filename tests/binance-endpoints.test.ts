import { describe, expect, it } from 'vitest';
import { AppConfigSchema, binanceRestBase, binanceWsBase } from '../src/config';

describe('Derivatives (USD-M) REST / WS defaults', () => {
  it('mainnet: fapi + fstream root', () => {
    const cfg = AppConfigSchema.parse({
      BINANCE_PRODUCT: 'usdm',
      BINANCE_FUTURES_TESTNET: false,
    });
    expect(binanceRestBase(cfg)).toBe('https://fapi.binance.com');
    expect(binanceWsBase(cfg)).toBe('wss://fstream.binance.com');
  });

  it('testnet: demo-fapi + fstream.binancefuture root per derivatives general-info', () => {
    const cfg = AppConfigSchema.parse({
      BINANCE_PRODUCT: 'usdm',
      BINANCE_FUTURES_TESTNET: true,
    });
    expect(binanceRestBase(cfg)).toBe('https://demo-fapi.binance.com');
    expect(binanceWsBase(cfg)).toBe('wss://fstream.binancefuture.com');
  });

  it('explicit BINANCE_REST_BASE overrides testnet default', () => {
    const cfg = AppConfigSchema.parse({
      BINANCE_PRODUCT: 'usdm',
      BINANCE_FUTURES_TESTNET: true,
      BINANCE_REST_BASE: 'https://fapi.binance.com',
    });
    expect(binanceRestBase(cfg)).toBe('https://fapi.binance.com');
  });
});
