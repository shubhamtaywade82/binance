import { describe, expect, it } from 'vitest';
import { resolvePairMap } from '../src/mapping/symbol-map';
import type { AppConfig } from '../src/config';

const sample: AppConfig = {
  BINANCE_PRODUCT: 'usdm',
  BINANCE_REST_BASE: undefined,
  BINANCE_WS_BASE: undefined,
  BINANCE_SYMBOL: 'solusdt',
  BINANCE_KLINE_INTERVAL: '15m',
  BINANCE_HTF_INTERVAL: '1h',
  COINDCX_API_KEY: '',
  COINDCX_API_SECRET: '',
  API_BASE_URL: 'https://api.coindcx.com',
  PUBLIC_BASE_URL: 'https://public.coindcx.com',
  COINDCX_PAIR: 'B-SOL_USDT',
  READ_ONLY: true,
  EXECUTION_ENABLED: false,
};

describe('resolvePairMap', () => {
  it('uppercases Binance symbol and preserves CoinDCX pair', () => {
    const m = resolvePairMap(sample);
    expect(m.binanceSymbol).toBe('SOLUSDT');
    expect(m.coindcxPair).toBe('B-SOL_USDT');
  });
});
