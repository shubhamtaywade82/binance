import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchBinanceExchangeInfoForSymbols,
  parseInstrumentPrecisionFromExchangeSymbol,
} from '../src/binance/rest-exchange-info';

afterEach(() => {
  nock.cleanAll();
});

describe('fetchBinanceExchangeInfoForSymbols', () => {
  it('returns a map keyed by uppercase symbol', async () => {
    nock('https://fapi.binance.com')
      .get('/fapi/v1/exchangeInfo')
      .reply(200, {
        symbols: [
          {
            symbol: 'BTCUSDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.10' },
              { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
            ],
            pricePrecision: 8,
            quantityPrecision: 8,
          },
          {
            symbol: 'SOLUSDT',
            status: 'TRADING',
            filters: [
              { filterType: 'PRICE_FILTER', tickSize: '0.0100' },
              { filterType: 'LOT_SIZE', stepSize: '0.01', minQty: '0.01' },
            ],
            pricePrecision: 8,
            quantityPrecision: 8,
          },
        ],
      });

    const m = await fetchBinanceExchangeInfoForSymbols('https://fapi.binance.com', [
      'btcusdt',
      'solusdt',
      'MISSING',
    ]);
    expect(m.get('BTCUSDT')?.tickSize).toBe(0.1);
    expect(m.get('SOLUSDT')?.tickSize).toBe(0.01);
    expect(m.has('MISSING')).toBe(false);
  });
});

describe('parseInstrumentPrecisionFromExchangeSymbol', () => {
  it('returns null when no PRICE_FILTER tick', () => {
    expect(
      parseInstrumentPrecisionFromExchangeSymbol({
        symbol: 'X',
        status: 'TRADING',
        filters: [{ filterType: 'LOT_SIZE', stepSize: '1', minQty: '1' }],
        pricePrecision: 8,
        quantityPrecision: 8,
      }),
    ).toBeNull();
  });
});
