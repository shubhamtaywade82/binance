import nock from 'nock';
import { describe, expect, it, afterEach } from 'vitest';
import { fetchUsdmMarkFromRest } from '../src/binance/rest-premium-index';
import type { AppConfig } from '../src/config';

const usdmCfg = {
  BINANCE_PRODUCT: 'usdm' as const,
  BINANCE_REST_BASE: undefined,
  BINANCE_WS_BASE: undefined,
  BINANCE_SYMBOL: 'SOLUSDT',
} as AppConfig;

afterEach(() => {
  nock.cleanAll();
});

describe('fetchUsdmMarkFromRest', () => {
  it('returns mark and time from premiumIndex', async () => {
    const scope = nock('https://fapi.binance.com')
      .get('/fapi/v1/premiumIndex')
      .query({ symbol: 'SOLUSDT' })
      .reply(200, { symbol: 'SOLUSDT', markPrice: '94.25', time: 1_778_446_590_013 });

    const r = await fetchUsdmMarkFromRest(usdmCfg, 'SOLUSDT');
    expect(r).toEqual({ markPrice: 94.25, eventTime: 1_778_446_590_013 });
    scope.done();
  });

  it('uses Date.now when time missing', async () => {
    const before = Date.now();
    nock('https://fapi.binance.com')
      .get('/fapi/v1/premiumIndex')
      .query({ symbol: 'SOLUSDT' })
      .reply(200, { symbol: 'SOLUSDT', markPrice: '1' });

    const r = await fetchUsdmMarkFromRest(usdmCfg, 'SOLUSDT');
    expect(r?.markPrice).toBe(1);
    expect(r?.eventTime).toBeGreaterThanOrEqual(before);
  });

  it('returns null for spot product', async () => {
    const spot = { ...usdmCfg, BINANCE_PRODUCT: 'spot' as const } as AppConfig;
    expect(await fetchUsdmMarkFromRest(spot, 'SOLUSDT')).toBeNull();
  });

  it('returns null when markPrice not numeric', async () => {
    nock('https://fapi.binance.com')
      .get('/fapi/v1/premiumIndex')
      .query({ symbol: 'SOLUSDT' })
      .reply(200, { symbol: 'SOLUSDT' });

    expect(await fetchUsdmMarkFromRest(usdmCfg, 'SOLUSDT')).toBeNull();
  });
});
