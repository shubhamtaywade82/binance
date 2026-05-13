import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import { placeBatchOrders, modifyBatchOrders, cancelBatchOrders } from '../src/binance/rest-trade';
import { BinanceLiveExecutionAdapter } from '../src/execution/binance-adapter';

describe('placeBatchOrders', () => {
  it('serializes orders with positionSide and sends JSON array', async () => {
    const signedPost = vi.fn().mockResolvedValue([
      { orderId: 1, status: 'NEW' },
      { orderId: 2, status: 'NEW' },
    ]);
    const client = { signedPost } as unknown as BinanceRestClient;

    const results = await placeBatchOrders(client, [
      { symbol: 'SOLUSDT', side: 'BUY', type: 'MARKET', quantity: 10, positionSide: 'LONG' },
      { symbol: 'SOLUSDT', side: 'SELL', type: 'STOP', quantity: 10, price: 160, stopPrice: 160, positionSide: 'LONG', reduceOnly: true },
    ]);

    expect(signedPost).toHaveBeenCalledWith('/fapi/v1/batchOrders', expect.objectContaining({
      batchOrders: expect.any(String),
    }));
    const parsed = JSON.parse((signedPost.mock.calls[0][1] as { batchOrders: string }).batchOrders);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].positionSide).toBe('LONG');
    expect(parsed[1].reduceOnly).toBe(true);
    expect(results).toHaveLength(2);
  });
});

describe('modifyBatchOrders', () => {
  it('sends PUT with JSON batch', async () => {
    const signedPut = vi.fn().mockResolvedValue([{ orderId: 1, status: 'NEW' }]);
    const client = { signedPut } as unknown as BinanceRestClient;

    await modifyBatchOrders(client, [
      { symbol: 'btcusdt', orderId: 1, side: 'BUY', quantity: 0.001, price: 100000 },
    ]);
    expect(signedPut).toHaveBeenCalledWith('/fapi/v1/batchOrders', expect.objectContaining({
      batchOrders: expect.any(String),
    }));
    const parsed = JSON.parse((signedPut.mock.calls[0][1] as { batchOrders: string }).batchOrders);
    expect(parsed[0].symbol).toBe('BTCUSDT');
  });
});

describe('cancelBatchOrders', () => {
  it('sends DELETE with orderIdList JSON', async () => {
    const signedDelete = vi.fn().mockResolvedValue([{ orderId: 1 }, { orderId: 2 }]);
    const client = { signedDelete } as unknown as BinanceRestClient;

    await cancelBatchOrders(client, 'solusdt', [1, 2]);
    expect(signedDelete).toHaveBeenCalledWith('/fapi/v1/batchOrders', {
      symbol: 'SOLUSDT',
      orderIdList: JSON.stringify([1, 2]),
    });
  });
});

describe('BinanceLiveExecutionAdapter.placeEntryWithBracket', () => {
  it('submits 3 orders in one batch and returns fill', async () => {
    const signedPost = vi.fn()
      .mockResolvedValueOnce({}) // setLeverage
      .mockResolvedValueOnce({}) // setMarginType
      .mockResolvedValueOnce([ // placeBatchOrders
        { orderId: 10, avgPrice: '170', status: 'FILLED' },
        { orderId: 11, status: 'NEW' },
        { orderId: 12, status: 'NEW' },
      ]);
    const client = { signedPost, signedGet: vi.fn(), signedDelete: vi.fn(), signedPut: vi.fn() } as unknown as BinanceRestClient;

    const adapter = new BinanceLiveExecutionAdapter({
      client,
      symbol: 'SOLUSDT',
      takerFee: 0.0004,
      fundingFeeEst: 0.0001,
      log: () => {},
    });
    adapter.setPrecision({ tickSize: 0.01, stepSize: 0.1, minQty: 0.1 });

    const result = await adapter.placeEntryWithBracket({
      side: 'LONG',
      quantity: 10,
      referencePrice: 170,
      leverage: 5,
      takeProfit: 175,
      stopLoss: 165,
    });

    expect(result.ok).toBe(true);
    expect(result.fill.price).toBe(170);
    expect(result.fill.quantity).toBe(10);
    // Third signedPost call is the batch (after leverage + marginType)
    const batchCall = signedPost.mock.calls[2];
    expect(batchCall[0]).toBe('/fapi/v1/batchOrders');
    const batch = JSON.parse(batchCall[1].batchOrders);
    expect(batch).toHaveLength(3);
    expect(batch[0].type).toBe('MARKET');
    expect(batch[1].type).toBe('TAKE_PROFIT');
    expect(batch[2].type).toBe('STOP');
  });

  it('falls back to sequential placeOrder on batch failure', async () => {
    let callCount = 0;
    const signedPost = vi.fn().mockImplementation(async (path: string) => {
      callCount++;
      if (callCount <= 2) return {}; // leverage + marginType
      if (callCount === 3) throw new Error('batch failed'); // batch
      // fallback sequential: leverage, marginType, entry, tp1, tp2, sl
      if (callCount <= 5) return {};
      if (callCount === 6) return { orderId: 20, avgPrice: '170', status: 'FILLED' };
      return { strategyId: 100 + callCount };
    });
    const client = { signedPost, signedGet: vi.fn(), signedDelete: vi.fn(), signedPut: vi.fn() } as unknown as BinanceRestClient;

    const adapter = new BinanceLiveExecutionAdapter({
      client,
      symbol: 'SOLUSDT',
      takerFee: 0.0004,
      fundingFeeEst: 0.0001,
      log: () => {},
    });
    adapter.setPrecision({ tickSize: 0.01, stepSize: 0.1, minQty: 0.1 });

    const result = await adapter.placeEntryWithBracket({
      side: 'LONG',
      quantity: 10,
      referencePrice: 170,
      leverage: 5,
      takeProfit: 175,
      stopLoss: 165,
    });

    expect(result.ok).toBe(true);
    // Should have fallen back to sequential flow
    expect(signedPost.mock.calls.length).toBeGreaterThan(3);
  });
});
