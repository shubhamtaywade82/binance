import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import {
  getMultiAssetsMargin,
  getRecentTrades,
  getHistoricalTrades,
} from '../src/binance/rest-trade';
import {
  buildStreamList,
  type MultiplexOptions,
  type MiniTickerEvent,
  type ContractInfoEvent,
  type MultiplexCallbacks,
} from '../src/binance/ws-multiplex';
import type { PrivateWsCallbacks } from '../src/binance/private-ws';

const makeMockClient = (overrides: Partial<BinanceRestClient> = {}): BinanceRestClient => ({
  publicGet: vi.fn().mockResolvedValue({}),
  signedGet: vi.fn().mockResolvedValue({}),
  signedPost: vi.fn().mockResolvedValue({}),
  signedPut: vi.fn().mockResolvedValue({}),
  signedDelete: vi.fn().mockResolvedValue({}),
  ...overrides,
} as unknown as BinanceRestClient);

// ─── REST gaps ──────────────────────────────────────────────────────────────

describe('getMultiAssetsMargin', () => {
  it('calls signedGet on /fapi/v1/multiAssetsMargin', async () => {
    const client = makeMockClient({ signedGet: vi.fn().mockResolvedValue({ multiAssetsMargin: true }) });
    const result = await getMultiAssetsMargin(client);
    expect(result.multiAssetsMargin).toBe(true);
    expect(client.signedGet).toHaveBeenCalledWith('/fapi/v1/multiAssetsMargin');
  });
});

describe('getRecentTrades', () => {
  it('fetches trades with symbol and limit', async () => {
    const trades = [{ id: 1, price: '150', qty: '10', quoteQty: '1500', time: 1, isBuyerMaker: false }];
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue(trades) });
    const result = await getRecentTrades(client, 'solusdt', 5);
    expect(result).toEqual(trades);
    expect(client.publicGet).toHaveBeenCalledWith('/fapi/v1/trades', { symbol: 'SOLUSDT', limit: 5 });
  });

  it('omits limit when not specified', async () => {
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue([]) });
    await getRecentTrades(client, 'ETHUSDT');
    expect(client.publicGet).toHaveBeenCalledWith('/fapi/v1/trades', { symbol: 'ETHUSDT' });
  });
});

describe('getHistoricalTrades', () => {
  it('fetches trades with fromId', async () => {
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue([]) });
    await getHistoricalTrades(client, 'btcusdt', { limit: 100, fromId: 42 });
    expect(client.publicGet).toHaveBeenCalledWith('/fapi/v1/historicalTrades', {
      symbol: 'BTCUSDT',
      limit: 100,
      fromId: 42,
    });
  });

  it('works without optional params', async () => {
    const client = makeMockClient({ publicGet: vi.fn().mockResolvedValue([]) });
    await getHistoricalTrades(client, 'SOLUSDT');
    expect(client.publicGet).toHaveBeenCalledWith('/fapi/v1/historicalTrades', { symbol: 'SOLUSDT' });
  });
});

// ─── WS stream list ─────────────────────────────────────────────────────────

describe('buildStreamList — new stream options', () => {
  const baseOpts: MultiplexOptions = {
    symbols: ['SOLUSDT'],
    timeframes: ['15m'],
    product: 'usdm',
    useBookTicker: false,
    useAggTrade: false,
    depthLevels: 0 as any,
    depthSpeed: '100ms' as any,
    useMarkPrice: false,
    baseWsUrl: 'wss://fstream.binance.com',
  };

  it('includes per-symbol miniTicker when useMiniTicker=true', () => {
    const streams = buildStreamList({ ...baseOpts, useMiniTicker: true });
    expect(streams).toContain('solusdt@miniTicker');
  });

  it('includes !ticker@arr when useGlobalTicker=true', () => {
    const streams = buildStreamList({ ...baseOpts, useGlobalTicker: true });
    expect(streams).toContain('!ticker@arr');
  });

  it('includes !miniTicker@arr when useGlobalMiniTicker=true', () => {
    const streams = buildStreamList({ ...baseOpts, useGlobalMiniTicker: true });
    expect(streams).toContain('!miniTicker@arr');
  });

  it('includes !bookTicker when useGlobalBookTicker=true', () => {
    const streams = buildStreamList({ ...baseOpts, useGlobalBookTicker: true });
    expect(streams).toContain('!bookTicker');
  });

  it('includes !contractInfo when useContractInfo=true and product=usdm', () => {
    const streams = buildStreamList({ ...baseOpts, useContractInfo: true });
    expect(streams).toContain('!contractInfo');
  });

  it('excludes !contractInfo for spot product', () => {
    const streams = buildStreamList({ ...baseOpts, product: 'spot', useContractInfo: true });
    expect(streams).not.toContain('!contractInfo');
  });

  it('does not include new streams by default', () => {
    const streams = buildStreamList(baseOpts);
    expect(streams.some(s => s.includes('miniTicker'))).toBe(false);
    expect(streams).not.toContain('!ticker@arr');
    expect(streams).not.toContain('!miniTicker@arr');
    expect(streams).not.toContain('!bookTicker');
    expect(streams).not.toContain('!contractInfo');
  });
});

// ─── Event type shapes ──────────────────────────────────────────────────────

describe('MiniTickerEvent shape', () => {
  it('has expected fields', () => {
    const e: MiniTickerEvent = {
      symbol: 'SOLUSDT',
      close: 150.5,
      open: 148.0,
      high: 152.0,
      low: 147.0,
      volume: 100000,
      quoteVolume: 15000000,
      eventTime: Date.now(),
    };
    expect(e.symbol).toBe('SOLUSDT');
    expect(e.close).toBe(150.5);
  });
});

describe('ContractInfoEvent shape', () => {
  it('has expected fields', () => {
    const e: ContractInfoEvent = {
      symbol: 'SOLUSDT',
      pair: 'SOLUSDT',
      contractType: 'PERPETUAL',
      deliveryDate: 0,
      onboardDate: 1609459200000,
      contractStatus: 'TRADING',
      eventTime: Date.now(),
    };
    expect(e.contractType).toBe('PERPETUAL');
    expect(e.contractStatus).toBe('TRADING');
  });
});

// ─── MultiplexCallbacks includes new handlers ───────────────────────────────

describe('MultiplexCallbacks includes new event handlers', () => {
  it('accepts onMiniTicker callback', () => {
    const cb: MultiplexCallbacks = { onMiniTicker: vi.fn() };
    expect(cb.onMiniTicker).toBeDefined();
  });

  it('accepts onContractInfo callback', () => {
    const cb: MultiplexCallbacks = { onContractInfo: vi.fn() };
    expect(cb.onContractInfo).toBeDefined();
  });
});

// ─── PrivateWsCallbacks includes STRATEGY_UPDATE and GRID_UPDATE ────────────

describe('PrivateWsCallbacks includes strategy/grid handlers', () => {
  it('accepts onStrategyUpdate callback', () => {
    const cb: PrivateWsCallbacks = { onStrategyUpdate: vi.fn() };
    expect(cb.onStrategyUpdate).toBeDefined();
  });

  it('accepts onGridUpdate callback', () => {
    const cb: PrivateWsCallbacks = { onGridUpdate: vi.fn() };
    expect(cb.onGridUpdate).toBeDefined();
  });
});
