import { describe, expect, it } from 'vitest';
import { AppConfigSchema, binanceRestBase, binanceWsBase, ollamaApiUrl, OLLAMA_CLOUD_API_URL, OLLAMA_LOCAL_API_URL } from '../src/config';

describe('Derivatives (USD-M) REST / WS defaults', () => {
  it('mainnet: fapi + fstream root', () => {
    const cfg = AppConfigSchema.parse({
      BINANCE_PRODUCT: 'usdm',
      BINANCE_FUTURES_TESTNET: false,
    });
    expect(binanceRestBase(cfg)).toBe('https://fapi.binance.com');
    expect(binanceWsBase(cfg)).toBe('wss://fstream.binance.com');
  });

  it('testnet: testnet.binancefuture.com + fstream.binancefuture root', () => {
    const cfg = AppConfigSchema.parse({
      BINANCE_PRODUCT: 'usdm',
      BINANCE_FUTURES_TESTNET: true,
    });
    expect(binanceRestBase(cfg)).toBe('https://testnet.binancefuture.com');
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

  it('treats empty BINANCE_REST_BASE as unset so testnet default applies', () => {
    const cfg = AppConfigSchema.parse({
      BINANCE_PRODUCT: 'usdm',
      BINANCE_FUTURES_TESTNET: true,
      BINANCE_REST_BASE: '',
    });
    expect(cfg.BINANCE_REST_BASE).toBeUndefined();
    expect(binanceRestBase(cfg)).toBe('https://testnet.binancefuture.com');
  });
});

describe('Ollama dashboard target', () => {
  it('defaults to local and maps to the fixed local API URL', () => {
    const cfg = AppConfigSchema.parse({});
    expect(cfg.OLLAMA_TARGET).toBe('local');
    expect(ollamaApiUrl(cfg.OLLAMA_TARGET)).toBe(OLLAMA_LOCAL_API_URL);
  });

  it('maps cloud target to the fixed Ollama Cloud URL', () => {
    const cfg = AppConfigSchema.parse({ OLLAMA_TARGET: 'cloud' });
    expect(cfg.OLLAMA_TARGET).toBe('cloud');
    expect(ollamaApiUrl(cfg.OLLAMA_TARGET)).toBe(OLLAMA_CLOUD_API_URL);
  });

  it('treats unknown OLLAMA_TARGET values as local', () => {
    const cfg = AppConfigSchema.parse({ OLLAMA_TARGET: 'custom-host' });
    expect(cfg.OLLAMA_TARGET).toBe('local');
  });
});
