import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchHistoricalKlines } from '../src/binance/historical';
import type { AppConfig } from '../src/config';

const baseCfg: AppConfig = {
  BINANCE_PRODUCT: 'usdm',
  BINANCE_REST_BASE: undefined,
  BINANCE_WS_BASE: undefined,
  BINANCE_SYMBOL: 'SOLUSDT',
  BINANCE_KLINE_INTERVAL: '1m',
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

afterEach(() => nock.cleanAll());

const makeRows = (start: number, count: number, stepMs = 60_000): unknown[][] => {
  const out: unknown[][] = [];
  for (let i = 0; i < count; i += 1) {
    const t = start + i * stepMs;
    out.push([t, '1', '1', '1', '1', '1', t + stepMs - 1]);
  }
  return out;
}

describe('fetchHistoricalKlines', () => {
  it('paginates across multiple pages, dedupes and sorts', async () => {
    const start = 1_700_000_000_000;
    const stepMs = 60_000;
    const fullPage = makeRows(start, 1500, stepMs);
    const secondPage = makeRows(start + 1500 * stepMs, 1500, stepMs);
    const thirdPage = makeRows(start + 3000 * stepMs, 100, stepMs);

    const scope = nock('https://fapi.binance.com')
      .get('/fapi/v1/klines').query(true).reply(200, fullPage)
      .get('/fapi/v1/klines').query(true).reply(200, secondPage)
      .get('/fapi/v1/klines').query(true).reply(200, thirdPage);

    const out = await fetchHistoricalKlines(baseCfg, {
      symbol: 'SOLUSDT',
      interval: '1m',
      startMs: start,
      endMs: start + 4000 * stepMs,
      pageDelayMs: 0,
    });
    expect(out.length).toBe(3100);
    expect(out[0].openTime).toBe(start);
    expect(out[out.length - 1].openTime).toBe(start + 3099 * stepMs);
    scope.done();
  });

  it('honors maxBars cap', async () => {
    const start = 1_700_000_000_000;
    const stepMs = 60_000;
    const fullPage = makeRows(start, 1500, stepMs);

    const scope = nock('https://fapi.binance.com')
      .get('/fapi/v1/klines').query(true).reply(200, fullPage);

    const out = await fetchHistoricalKlines(baseCfg, {
      symbol: 'SOLUSDT',
      interval: '1m',
      startMs: start,
      endMs: start + 1500 * stepMs,
      maxBars: 100,
      pageDelayMs: 0,
    });
    expect(out.length).toBe(100);
    scope.done();
  });
});
