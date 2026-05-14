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

describe('P0 safety env defaults', () => {
  it('parses deadman, drawdown, and order-rate pause defaults', () => {
    const cfg = AppConfigSchema.parse({});
    expect(cfg.BINANCE_DEADMAN_COUNTDOWN_MS).toBe(0);
    expect(cfg.DAILY_DRAWDOWN_KILL_PCT).toBe(0);
    expect(cfg.ORDER_RATE_LIMIT_PAUSE_THRESHOLD).toBe(0);
  });

  it('accepts positive deadman and drawdown', () => {
    const cfg = AppConfigSchema.parse({
      BINANCE_DEADMAN_COUNTDOWN_MS: '120000',
      DAILY_DRAWDOWN_KILL_PCT: '0.03',
      ORDER_RATE_LIMIT_PAUSE_THRESHOLD: '0.9',
    });
    expect(cfg.BINANCE_DEADMAN_COUNTDOWN_MS).toBe(120_000);
    expect(cfg.DAILY_DRAWDOWN_KILL_PCT).toBe(0.03);
    expect(cfg.ORDER_RATE_LIMIT_PAUSE_THRESHOLD).toBe(0.9);
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

describe('AI SuperTrend tuning env', () => {
  it('defaults tuning off and interval to 300s', () => {
    const cfg = AppConfigSchema.parse({});
    expect(cfg.AI_SUPERTREND_TUNING_ENABLED).toBe(false);
    expect(cfg.AI_SUPERTREND_TUNING_INTERVAL_SEC).toBe(300);
  });

  it('defaults AI brief think/stream off', () => {
    const cfg = AppConfigSchema.parse({});
    expect(cfg.AI_BRIEF_THINK_ENABLED).toBe(false);
    expect(cfg.AI_BRIEF_STREAM_ENABLED).toBe(false);
  });

  it('parses tuning enabled and interval bounds', () => {
    const cfg = AppConfigSchema.parse({
      AI_SUPERTREND_TUNING_ENABLED: 'true',
      AI_SUPERTREND_TUNING_INTERVAL_SEC: '90',
    });
    expect(cfg.AI_SUPERTREND_TUNING_ENABLED).toBe(true);
    expect(cfg.AI_SUPERTREND_TUNING_INTERVAL_SEC).toBe(90);
  });
});
