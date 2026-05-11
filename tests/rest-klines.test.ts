import nock from 'nock';
import { describe, expect, it, afterEach } from 'vitest';
import { fetchBinanceKlines, normalizeBinanceKlineRow } from '../src/binance/rest-klines';
import type { AppConfig } from '../src/config';

const baseCfg: AppConfig = {
  BINANCE_PRODUCT: 'usdm',
  BINANCE_REST_BASE: undefined,
  BINANCE_WS_BASE: undefined,
  BINANCE_SYMBOL: 'SOLUSDT',
  BINANCE_KLINE_INTERVAL: '15m',
  BINANCE_HTF_INTERVAL: '1h',
  COINDCX_API_KEY: '',
  COINDCX_API_SECRET: '',
  API_BASE_URL: 'https://api.coindcx.com',
  PUBLIC_BASE_URL: 'https://public.coindcx.com',
  COINDCX_PAIR: 'B-SOL_USDT',
  READ_ONLY: true,
  PLACE_ORDER: false,
  USDM_MARK_REST_POLL_SEC: 0,
} as AppConfig;

afterEach(() => {
  nock.cleanAll();
});

describe('normalizeBinanceKlineRow', () => {
  it('maps a Binance kline array to Candle', () => {
    const row = [1_700_000_000_000, '1.1', '1.2', '1.0', '1.15', '99.5', 1_700_000_599_999];
    const c = normalizeBinanceKlineRow(row);
    expect(c).toEqual({
      openTime: 1_700_000_000_000,
      open: 1.1,
      high: 1.2,
      low: 1,
      close: 1.15,
      volume: 99.5,
      closeTime: 1_700_000_599_999,
    });
  });

  it('returns null for invalid rows', () => {
    expect(normalizeBinanceKlineRow([])).toBeNull();
    expect(normalizeBinanceKlineRow(['x', 1, 2, 3, 4, 5])).toBeNull();
  });
});

describe('fetchBinanceKlines', () => {
  it('fetches USD-M klines', async () => {
    const scope = nock('https://fapi.binance.com')
      .get('/fapi/v1/klines')
      .query({ symbol: 'SOLUSDT', interval: '15m', limit: 2 })
      .reply(200, [
        [1000, '1', '1', '1', '1', '10', 1999],
        [2000, '1', '2', '1', '2', '20', 2999],
      ]);

    const candles = await fetchBinanceKlines(baseCfg, {
      symbol: 'SOLUSDT',
      interval: '15m',
      limit: 2,
    });
    expect(candles).toHaveLength(2);
    expect(candles[1].close).toBe(2);
    scope.done();
  });
});
