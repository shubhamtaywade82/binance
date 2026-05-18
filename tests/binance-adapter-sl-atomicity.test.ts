import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import { BinanceLiveExecutionAdapter } from '../src/execution/binance-adapter';

/**
 * M-20: SL placement is mandatory. When the algo SL call fails after the
 * MARKET entry has filled, the adapter must unwind the entry rather than
 * leave a position open with no stop. TP1/TP2 failures are recoverable
 * (close-position fallbacks exist) and do NOT unwind the entry.
 */
describe('BinanceLiveExecutionAdapter SL atomicity (M-20)', () => {
  const buildAdapter = (algoResponses: Array<{ ok: boolean; strategyId?: number; err?: string }>) => {
    const cancelDeleteCalls: string[] = [];
    const closeMarketCalls: any[] = [];
    let algoIdx = 0;
    const signedPost = vi.fn().mockImplementation(async (path: string, body: any) => {
      if (path === '/fapi/v1/leverage' || path === '/fapi/v1/marginType') return {};
      if (path === '/fapi/v1/order') {
        // entry MARKET OR emergency unwind MARKET
        if (body?.reduceOnly === 'true' || body?.reduceOnly === true) {
          closeMarketCalls.push(body);
          return { orderId: 999, avgPrice: '100', status: 'FILLED' };
        }
        return { orderId: 100, avgPrice: '100', status: 'FILLED' };
      }
      if (path === '/fapi/v1/algoOrder') {
        const r = algoResponses[algoIdx++];
        if (r.ok) return { strategyId: r.strategyId };
        throw new Error(r.err ?? 'algo failed');
      }
      return {};
    });
    const signedDelete = vi.fn().mockImplementation(async (path: string) => {
      cancelDeleteCalls.push(path);
      return {};
    });
    const client = { signedPost, signedDelete, signedGet: vi.fn(), signedPut: vi.fn() } as unknown as BinanceRestClient;
    const adapter = new BinanceLiveExecutionAdapter({
      client,
      symbol: 'SOLUSDT',
      takerFee: 0.0005,
      fundingFeeEst: 0.0001,
      log: () => undefined,
    });
    adapter.setPrecision({ tickSize: 0.01, stepSize: 0.1, minQty: 0.1 });
    return { adapter, signedPost, signedDelete, cancelDeleteCalls, closeMarketCalls };
  };

  it('returns ok=true when SL lands successfully (TP1 + TP2 + SL all OK)', async () => {
    const { adapter } = buildAdapter([
      { ok: true, strategyId: 7001 }, // TP1
      { ok: true, strategyId: 7002 }, // TP2
      { ok: true, strategyId: 7003 }, // SL
    ]);
    const r = await adapter.placeOrder({
      pair: 'SOLUSDT', side: 'LONG', quantity: 10, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
      takeProfit: 101.5, stopLoss: 99,
    });
    expect(r.ok).toBe(true);
  });

  it('returns ok=true when TP1/TP2 fail but SL lands — SL is the only mandatory leg', async () => {
    const { adapter } = buildAdapter([
      { ok: false, err: 'tp1 rejected' }, // TP1 fails
      { ok: false, err: 'tp2 rejected' }, // TP2 fails
      { ok: true, strategyId: 7003 },     // SL succeeds
    ]);
    const r = await adapter.placeOrder({
      pair: 'SOLUSDT', side: 'LONG', quantity: 10, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
      takeProfit: 101.5, stopLoss: 99,
    });
    expect(r.ok).toBe(true);
  });

  it('UNWINDS the entry when SL placement fails — returns ok=false + cancels TPs + emits reduceOnly market close', async () => {
    const ctx = buildAdapter([
      { ok: true, strategyId: 7001 }, // TP1 lands
      { ok: true, strategyId: 7002 }, // TP2 lands
      { ok: false, err: 'sl rejected' }, // SL fails
    ]);
    const r = await ctx.adapter.placeOrder({
      pair: 'SOLUSDT', side: 'LONG', quantity: 10, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
      takeProfit: 101.5, stopLoss: 99,
    });

    expect(r.ok).toBe(false);
    expect(r.error).toBe('sl_placement_failed_entry_unwound');

    // Sibling cancel-all dispatched.
    expect(ctx.signedDelete).toHaveBeenCalled();
    // Reduce-only market close was issued for the entry quantity.
    expect(ctx.closeMarketCalls).toHaveLength(1);
    expect(Number(ctx.closeMarketCalls[0].quantity)).toBe(10);
    expect(ctx.closeMarketCalls[0].side).toBe('SELL');

    // Internal trade map is NOT populated for the failed-bracket entry,
    // so a subsequent close request against the (failed) orderId would
    // throw rather than silently succeed.
    expect(ctx.adapter.hasOpenTrade(r.orderId)).toBe(false);
  });

  it('returns ok=false even if the emergency unwind itself errors (operator escalation)', async () => {
    const signedPost = vi.fn().mockImplementation(async (path: string, body: any) => {
      if (path === '/fapi/v1/leverage' || path === '/fapi/v1/marginType') return {};
      if (path === '/fapi/v1/order') {
        if (body?.reduceOnly === 'true' || body?.reduceOnly === true) {
          throw new Error('exchange offline');
        }
        return { orderId: 100, avgPrice: '100', status: 'FILLED' };
      }
      if (path === '/fapi/v1/algoOrder') throw new Error('sl rejected');
      return {};
    });
    const client = { signedPost, signedDelete: vi.fn().mockResolvedValue({}), signedGet: vi.fn(), signedPut: vi.fn() } as unknown as BinanceRestClient;
    const adapter = new BinanceLiveExecutionAdapter({
      client, symbol: 'SOLUSDT', takerFee: 0.0005, fundingFeeEst: 0.0001, log: () => undefined,
    });
    adapter.setPrecision({ tickSize: 0.01, stepSize: 0.1, minQty: 0.1 });

    const r = await adapter.placeOrder({
      pair: 'SOLUSDT', side: 'LONG', quantity: 10, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
      takeProfit: 101.5, stopLoss: 99,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('sl_placement_failed_entry_unwound');
  });
});
