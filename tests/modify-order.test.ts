import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import { modifyOrder } from '../src/binance/rest-trade';
import { BinanceLiveExecutionAdapter } from '../src/execution/binance-adapter';

describe('modifyOrder REST helper', () => {
  it('sends PUT with orderId, side, quantity, price', async () => {
    const signedPut = vi.fn().mockResolvedValue({
      orderId: 123,
      symbol: 'SOLUSDT',
      status: 'NEW',
      price: '170.50',
      origQty: '1.0',
    });
    const client = { signedPut } as unknown as BinanceRestClient;
    const r = await modifyOrder(client, {
      symbol: 'solusdt',
      orderId: 123,
      side: 'BUY',
      quantity: 1.0,
      price: 170.5,
    });
    expect(signedPut).toHaveBeenCalledWith('/fapi/v1/order', {
      symbol: 'SOLUSDT',
      orderId: 123,
      side: 'BUY',
      quantity: 1.0,
      price: 170.5,
    });
    expect(r.orderId).toBe(123);
  });

  it('includes priceMatch when provided', async () => {
    const signedPut = vi.fn().mockResolvedValue({ orderId: 456 });
    const client = { signedPut } as unknown as BinanceRestClient;
    await modifyOrder(client, {
      symbol: 'BTCUSDT',
      orderId: 456,
      side: 'SELL',
      quantity: 0.001,
      price: 100000,
      priceMatch: 'OPPONENT',
    });
    expect(signedPut).toHaveBeenCalledWith('/fapi/v1/order', expect.objectContaining({
      priceMatch: 'OPPONENT',
    }));
  });
});

describe('BinanceLiveExecutionAdapter.amendAlgoStopPrice', () => {
  const stubClient = () => {
    const signedPost = vi.fn()
      .mockResolvedValueOnce({}) // setLeverage
      .mockResolvedValueOnce({}) // setMarginType
      .mockResolvedValueOnce({ // placeOrder (entry)
        orderId: 1, avgPrice: '170', status: 'FILLED',
      })
      .mockResolvedValueOnce({ strategyId: 100 }) // TP1 algo
      .mockResolvedValueOnce({ strategyId: 200 }) // TP2 algo
      .mockResolvedValueOnce({ strategyId: 300 }); // SL algo
    const signedGet = vi.fn().mockResolvedValue([]);
    const signedDelete = vi.fn().mockResolvedValue({ code: 200 });
    return { signedPost, signedGet, signedDelete, signedPut: vi.fn() } as unknown as BinanceRestClient;
  };

  const buildAdapter = (client: BinanceRestClient) =>
    new BinanceLiveExecutionAdapter({
      client,
      symbol: 'SOLUSDT',
      takerFee: 0.0004,
      fundingFeeEst: 0.0001,
      log: () => {},
    });

  it('cancels old algo and places new one with updated stop price', async () => {
    const client = stubClient();
    const adapter = buildAdapter(client);
    adapter.setPrecision({ tickSize: 0.01, stepSize: 0.1, minQty: 0.1 });

    await adapter.placeOrder({
      side: 'LONG',
      quantity: 10,
      referencePrice: 170,
      leverage: 5,
      takeProfit: 175,
      stopLoss: 165,
    });

    // Now replace the SL algo. Need to mock the cancel + new place.
    const signedDelete = client.signedDelete as ReturnType<typeof vi.fn>;
    signedDelete.mockResolvedValueOnce({ strategyId: 300 });
    const signedPost = client.signedPost as ReturnType<typeof vi.fn>;
    signedPost.mockResolvedValueOnce({ strategyId: 301 });

    const newId = await adapter.amendAlgoStopPrice(
      (await getInternalId(adapter)),
      'SL',
      163.0,
    );
    expect(newId).toBe(301);
    expect(signedDelete).toHaveBeenCalledWith('/fapi/v1/algoOrder', expect.objectContaining({
      strategyId: 300,
    }));
  });

  it('returns null for unknown internalId', async () => {
    const client = stubClient();
    const adapter = buildAdapter(client);
    const result = await adapter.amendAlgoStopPrice('nonexistent', 'SL', 160);
    expect(result).toBeNull();
  });
});

async function getInternalId(adapter: BinanceLiveExecutionAdapter): Promise<string> {
  return (adapter as unknown as { trades: Map<string, { internalId: string }> }).trades.keys().next().value!;
}
