import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import {
  getOpenInterest,
  getOpenInterestHist,
  getFundingRateHistory,
} from '../src/binance/rest-trade';
import { buildStreamList, type MultiplexOptions } from '../src/binance/ws-multiplex';

describe('getOpenInterest', () => {
  it('fetches current OI for a symbol', async () => {
    const publicGet = vi.fn().mockResolvedValue({
      symbol: 'SOLUSDT',
      openInterest: '123456.789',
      time: 1700000000000,
    });
    const client = { publicGet } as unknown as BinanceRestClient;
    const r = await getOpenInterest(client, 'solusdt');
    expect(publicGet).toHaveBeenCalledWith('/fapi/v1/openInterest', { symbol: 'SOLUSDT' });
    expect(r.openInterest).toBe('123456.789');
  });
});

describe('getOpenInterestHist', () => {
  it('fetches OI statistics with period and limit', async () => {
    const publicGet = vi.fn().mockResolvedValue([
      { symbol: 'SOLUSDT', sumOpenInterest: '100000', sumOpenInterestValue: '17000000', timestamp: 1700000000000 },
    ]);
    const client = { publicGet } as unknown as BinanceRestClient;
    const rows = await getOpenInterestHist(client, { symbol: 'solusdt', period: '5m', limit: 10 });
    expect(publicGet).toHaveBeenCalledWith('/futures/data/openInterestHist', {
      symbol: 'SOLUSDT',
      period: '5m',
      limit: 10,
    });
    expect(rows).toHaveLength(1);
  });

  it('passes startTime and endTime', async () => {
    const publicGet = vi.fn().mockResolvedValue([]);
    const client = { publicGet } as unknown as BinanceRestClient;
    await getOpenInterestHist(client, { symbol: 'BTCUSDT', period: '1h', startTime: 1000, endTime: 2000 });
    expect(publicGet).toHaveBeenCalledWith('/futures/data/openInterestHist', expect.objectContaining({
      startTime: 1000,
      endTime: 2000,
    }));
  });
});

describe('getFundingRateHistory', () => {
  it('fetches funding rate history for a symbol', async () => {
    const publicGet = vi.fn().mockResolvedValue([
      { symbol: 'SOLUSDT', fundingRate: '0.00010000', fundingTime: 1700000000000, markPrice: '170.5' },
    ]);
    const client = { publicGet } as unknown as BinanceRestClient;
    const rows = await getFundingRateHistory(client, { symbol: 'solusdt', limit: 50 });
    expect(publicGet).toHaveBeenCalledWith('/fapi/v1/fundingRate', { symbol: 'SOLUSDT', limit: 50 });
    expect(rows[0].fundingRate).toBe('0.00010000');
  });

  it('works with no params', async () => {
    const publicGet = vi.fn().mockResolvedValue([]);
    const client = { publicGet } as unknown as BinanceRestClient;
    await getFundingRateHistory(client);
    expect(publicGet).toHaveBeenCalledWith('/fapi/v1/fundingRate', {});
  });
});

describe('!forceOrder@arr global stream', () => {
  const baseOpts: MultiplexOptions = {
    baseWsUrl: 'wss://fstream.binance.com/stream',
    symbols: ['SOLUSDT'],
    timeframes: ['5m'],
    product: 'usdm',
    useBookTicker: false,
    useAggTrade: false,
    depthLevels: 0 as 0,
    depthSpeed: '100ms',
    useMarkPrice: false,
    useForceOrder: false,
  };

  it('does not include !forceOrder@arr by default', () => {
    const streams = buildStreamList(baseOpts);
    expect(streams).not.toContain('!forceOrder@arr');
  });

  it('includes !forceOrder@arr when useGlobalForceOrder is true', () => {
    const streams = buildStreamList({ ...baseOpts, useGlobalForceOrder: true });
    expect(streams).toContain('!forceOrder@arr');
  });

  it('includes both per-symbol and global when both enabled', () => {
    const streams = buildStreamList({ ...baseOpts, useForceOrder: true, useGlobalForceOrder: true });
    expect(streams).toContain('solusdt@forceOrder');
    expect(streams).toContain('!forceOrder@arr');
  });
});
