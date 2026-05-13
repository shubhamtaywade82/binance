import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import {
  getAllOrders,
  getAlgoOrder,
  testNewOrder,
  getAccountConfig,
  getSymbolConfig,
  getBookTicker,
  getTicker24hr,
} from '../src/binance/rest-trade';

const makeMockClient = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient => ({
  publicGet: vi.fn().mockResolvedValue({}),
  signedGet: vi.fn().mockResolvedValue({}),
  signedPost: vi.fn().mockResolvedValue({}),
  signedPut: vi.fn().mockResolvedValue({}),
  signedDelete: vi.fn().mockResolvedValue({}),
  ...overrides,
} as unknown as BinanceRestClient);

describe('getAllOrders', () => {
  it('calls signedGet with correct params', async () => {
    const mockOrders = [{ orderId: 1, symbol: 'SOLUSDT', status: 'FILLED' }];
    const client = makeMockClient({ signedGet: vi.fn().mockResolvedValue(mockOrders) });

    const result = await getAllOrders(client, { symbol: 'solusdt', limit: 10 });
    expect(result).toEqual(mockOrders);
    expect(client.signedGet).toHaveBeenCalledWith('/fapi/v1/allOrders', { symbol: 'SOLUSDT', limit: 10 });
  });

  it('passes optional orderId and time filters', async () => {
    const client = makeMockClient({ signedGet: vi.fn().mockResolvedValue([]) });
    await getAllOrders(client, { symbol: 'ETHUSDT', orderId: 42, startTime: 1000, endTime: 2000 });
    expect(client.signedGet).toHaveBeenCalledWith('/fapi/v1/allOrders', {
      symbol: 'ETHUSDT',
      orderId: 42,
      startTime: 1000,
      endTime: 2000,
    });
  });
});

describe('getAlgoOrder', () => {
  it('queries by symbol + algoId', async () => {
    const mockAlgo = { strategyId: 99, symbol: 'SOLUSDT' };
    const client = makeMockClient({ signedGet: vi.fn().mockResolvedValue(mockAlgo) });

    const result = await getAlgoOrder(client, 'solusdt', 99);
    expect(result).toEqual(mockAlgo);
    expect(client.signedGet).toHaveBeenCalledWith('/fapi/v1/algoOrder', { symbol: 'SOLUSDT', algoId: 99 });
  });
});

describe('testNewOrder', () => {
  it('sends order params to test endpoint', async () => {
    const client = makeMockClient({ signedPost: vi.fn().mockResolvedValue({}) });
    await testNewOrder(client, { symbol: 'SOLUSDT', side: 'BUY', type: 'MARKET', quantity: 1 });
    expect(client.signedPost).toHaveBeenCalledWith('/fapi/v1/order/test', expect.objectContaining({
      symbol: 'SOLUSDT',
      side: 'BUY',
      type: 'MARKET',
      quantity: 1,
    }));
  });

  it('omits quantity when not provided', async () => {
    const client = makeMockClient({ signedPost: vi.fn().mockResolvedValue({}) });
    await testNewOrder(client, { symbol: 'SOLUSDT', side: 'BUY', type: 'MARKET' });
    const callArgs = (client.signedPost as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs).not.toHaveProperty('quantity');
  });
});

describe('getAccountConfig', () => {
  it('returns account configuration', async () => {
    const mockConfig = { feeTier: 2, canTrade: true, dualSidePosition: false, multiAssetsMargin: false };
    const client = makeMockClient({ signedGet: vi.fn().mockResolvedValue(mockConfig) });

    const result = await getAccountConfig(client);
    expect(result.feeTier).toBe(2);
    expect(result.canTrade).toBe(true);
  });
});

describe('getSymbolConfig', () => {
  it('queries per-symbol leverage config', async () => {
    const mockSymConfig = [{ symbol: 'SOLUSDT', leverage: 20, marginType: 'ISOLATED' }];
    const client = makeMockClient({ signedGet: vi.fn().mockResolvedValue(mockSymConfig) });

    const result = await getSymbolConfig(client, 'solusdt');
    expect(result[0].symbol).toBe('SOLUSDT');
    expect(client.signedGet).toHaveBeenCalledWith('/fapi/v1/symbolConfig', { symbol: 'SOLUSDT' });
  });
});

describe('getBookTicker', () => {
  it('fetches best bid/ask for a symbol', async () => {
    const mockTicker = { symbol: 'SOLUSDT', bidPrice: '150.1', askPrice: '150.2', bidQty: '100', askQty: '50', time: 1 };
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue(mockTicker) });

    const result = await getBookTicker(client, 'solusdt');
    expect(result).toEqual(mockTicker);
    expect(client.publicGet).toHaveBeenCalledWith('/fapi/v1/ticker/bookTicker', { symbol: 'SOLUSDT' });
  });

  it('omits symbol when not specified', async () => {
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue([]) });
    await getBookTicker(client);
    expect(client.publicGet).toHaveBeenCalledWith('/fapi/v1/ticker/bookTicker', {});
  });
});

describe('getTicker24hr', () => {
  it('fetches 24hr stats', async () => {
    const mockStats = { symbol: 'SOLUSDT', lastPrice: '150.5', volume: '1000000' };
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue(mockStats) });

    const result = await getTicker24hr(client, 'solusdt');
    expect(result).toEqual(mockStats);
  });

  it('fetches all tickers when no symbol specified', async () => {
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue([]) });
    await getTicker24hr(client);
    expect(client.publicGet).toHaveBeenCalledWith('/fapi/v1/ticker/24hr', {});
  });
});
