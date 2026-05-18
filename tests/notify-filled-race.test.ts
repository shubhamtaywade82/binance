import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import { BinanceLiveExecutionAdapter } from '../src/execution/binance-adapter';

/**
 * H-1: notifyFilled must (a) await cancellation of TP/SL siblings before
 * resolving, and (b) serialize against concurrent fills for the same trade
 * so a near-simultaneous SL + TP2 pair does not cause state corruption.
 */
describe('BinanceLiveExecutionAdapter.notifyFilled (H-1)', () => {
  const setupAdapter = async (): Promise<{
    adapter: BinanceLiveExecutionAdapter;
    client: { signedPost: ReturnType<typeof vi.fn>; signedDelete: ReturnType<typeof vi.fn>; signedGet: ReturnType<typeof vi.fn>; signedPut: ReturnType<typeof vi.fn> };
    tradeId: string;
    tp1Id: number;
    tp2Id: number;
    slId: number;
  }> => {
    const signedPost = vi.fn()
      // setLeverage
      .mockResolvedValueOnce({})
      // setMarginType
      .mockResolvedValueOnce({})
      // entry MARKET order
      .mockResolvedValueOnce({ orderId: 100, avgPrice: '100', status: 'FILLED' })
      // TP1 algoOrder
      .mockResolvedValueOnce({ strategyId: 7001 })
      // TP2 algoOrder
      .mockResolvedValueOnce({ strategyId: 7002 })
      // SL algoOrder
      .mockResolvedValueOnce({ strategyId: 7003 });
    const signedDelete = vi.fn().mockResolvedValue({});
    const client = { signedPost, signedDelete, signedGet: vi.fn(), signedPut: vi.fn() } as unknown as BinanceRestClient;

    const adapter = new BinanceLiveExecutionAdapter({
      client: client as BinanceRestClient,
      symbol: 'SOLUSDT',
      takerFee: 0.0005,
      fundingFeeEst: 0.0001,
      log: () => undefined,
    });
    adapter.setPrecision({ tickSize: 0.01, stepSize: 0.1, minQty: 0.1 });
    const result = await adapter.placeOrder({
      pair: 'SOLUSDT',
      side: 'LONG',
      quantity: 10,
      leverage: 5,
      marginCurrency: 'USDT',
      referencePrice: 100,
      takeProfit: 101.5,
      stopLoss: 99,
    });
    if (!result.ok) throw new Error(`placeOrder failed: ${result.error}`);
    return { adapter, client: client as any, tradeId: result.orderId, tp1Id: 7001, tp2Id: 7002, slId: 7003 };
  };

  it('returns null on TP1 partial fill and leaves the trade open', async () => {
    const { adapter, client, tp1Id } = await setupAdapter();
    const r = await adapter.notifyFilled(tp1Id, 100.9);
    expect(r).toBeNull();
    // No cancel calls — TP1 leaves SL armed (closePosition=true so it auto-sizes).
    expect(client.signedDelete).not.toHaveBeenCalled();
  });

  it('awaits sibling cancellation before resolving on TP2 fill', async () => {
    const { adapter, client, tp2Id } = await setupAdapter();
    // Slow the cancel calls to force the test to actually wait for them.
    let cancelsResolved = 0;
    client.signedDelete.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      cancelsResolved += 1;
      return {};
    });

    const r = await adapter.notifyFilled(tp2Id, 101.5);
    expect(r?.fullyFilled).toBe(true);
    expect(r?.closed.reason).toBe('TP');
    // Both cancelAllAlgoOrders + cancelAllOrders must have resolved by the
    // time notifyFilled() resolves.
    expect(cancelsResolved).toBe(2);
  });

  it('serializes concurrent TP2 + SL fills: second call returns null cleanly', async () => {
    const { adapter, client, tp2Id, slId } = await setupAdapter();
    client.signedDelete.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 25));
      return {};
    });

    // Fire both notifications concurrently. The first call to acquire the
    // closingIds guard runs to completion; the second observes the in-flight
    // close and returns null without double-publishing.
    const [first, second] = await Promise.all([
      adapter.notifyFilled(tp2Id, 101.5),
      adapter.notifyFilled(slId, 99),
    ]);

    const fulfilled = [first, second].filter((r) => r?.fullyFilled);
    const dropped = [first, second].filter((r) => r === null);
    expect(fulfilled).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    // Cancellations only ran for the surviving handler (2 deletes: algoOrders + orders).
    expect(client.signedDelete).toHaveBeenCalledTimes(2);
  });

  it('returns null for an unknown strategyId', async () => {
    const { adapter, client } = await setupAdapter();
    const r = await adapter.notifyFilled(999999, 100);
    expect(r).toBeNull();
    expect(client.signedDelete).not.toHaveBeenCalled();
  });

  it('releases the closingIds lock even when cancellation rejects', async () => {
    const { adapter, client, tp2Id } = await setupAdapter();
    client.signedDelete.mockRejectedValue(new Error('network'));
    const r = await adapter.notifyFilled(tp2Id, 101.5);
    // Promise.allSettled swallows the rejection so notifyFilled still resolves
    // with the close payload; importantly the lock is released so a follow-up
    // call (e.g. retry from another path) isn't permanently blocked.
    expect(r?.fullyFilled).toBe(true);
    // Re-issue should now be a no-op (trade is already gone) but should NOT
    // hang waiting for the lock.
    const r2 = await adapter.notifyFilled(tp2Id, 101.5);
    expect(r2).toBeNull();
  });
});
