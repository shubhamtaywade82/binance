import { describe, expect, it, vi } from 'vitest';
import {
  reconcilePositionsAtStartup,
  type ReconciliationLogger,
} from '../src/core/execution/reconciliation';
import type { ExecutionRuntime } from '../src/execution/create-runtime';

const cfg = {
  EXECUTION_MODE: 'live',
  BINANCE_SYMBOL: 'SOLUSDT',
} as any;

const silentLog: ReconciliationLogger = {
  info: () => undefined,
  warn: () => undefined,
};

describe('reconcilePositionsAtStartup', () => {
  it('returns paper positions verbatim when paperAdapter is set', async () => {
    const paperPositions = [
      { symbol: 'SOLUSDT', side: 'LONG' as const, quantity: 1, entryPrice: 100 },
      { symbol: 'ETHUSDT', side: 'SHORT' as const, quantity: 0.5, entryPrice: 3000 },
    ];
    const exec = {
      paperAdapter: { getOpenPositions: () => paperPositions },
    } as unknown as ExecutionRuntime;

    const r = await reconcilePositionsAtStartup(exec, cfg, ['SOLUSDT', 'ETHUSDT'], silentLog);
    expect(r.source).toBe('paper');
    expect(r.positions).toEqual(paperPositions);
    expect(r.errors).toHaveLength(0);
  });

  it('queries CoinDCX adapter when only cdcxAdapter is set', async () => {
    const getOpenPositions = vi.fn().mockResolvedValue([
      { symbol: 'B-SOL_USDT', side: 'LONG', quantity: 2, entryPrice: 99 },
      { symbol: 'B-ETH_USDT', side: 'SHORT', quantity: 0.1, entryPrice: 3100 },
    ]);
    const exec = { cdcxAdapter: { getOpenPositions } } as unknown as ExecutionRuntime;

    const r = await reconcilePositionsAtStartup(exec, cfg, ['SOLUSDT'], silentLog);
    expect(r.source).toBe('coindcx');
    expect(r.positions).toHaveLength(2);
    expect(r.positions[0]).toMatchObject({ symbol: 'B-SOL_USDT', side: 'LONG', quantity: 2 });
    expect(getOpenPositions).toHaveBeenCalledOnce();
  });

  it('filters out zero-quantity rows from CoinDCX', async () => {
    const exec = {
      cdcxAdapter: {
        getOpenPositions: async () => [
          { symbol: 'SOL', side: 'LONG', quantity: 0, entryPrice: 100 },
          { symbol: 'ETH', side: 'SHORT', quantity: 0.5, entryPrice: 3000 },
        ],
      },
    } as unknown as ExecutionRuntime;
    const r = await reconcilePositionsAtStartup(exec, cfg, [], silentLog);
    expect(r.positions).toHaveLength(1);
    expect(r.positions[0].symbol).toBe('ETH');
  });

  it('THROWS in strict mode when CoinDCX getOpenPositions throws', async () => {
    const exec = {
      cdcxAdapter: { getOpenPositions: async () => { throw new Error('network'); } },
    } as unknown as ExecutionRuntime;
    await expect(
      reconcilePositionsAtStartup(exec, cfg, [], silentLog, { strict: true }),
    ).rejects.toThrow(/startup_reconciliation_failed:coindcx:network/);
  });

  it('returns errors without throwing when strict=false', async () => {
    const exec = {
      cdcxAdapter: { getOpenPositions: async () => { throw new Error('boom'); } },
    } as unknown as ExecutionRuntime;
    const r = await reconcilePositionsAtStartup(exec, cfg, [], silentLog, { strict: false });
    expect(r.source).toBe('coindcx');
    expect(r.positions).toHaveLength(0);
    expect(r.errors[0]).toBe('boom');
  });

  it('reconciles Binance live: queries positionRisk + openAlgoOrders and invokes restoreFromExchange', async () => {
    const restore = vi.fn().mockReturnValue('internal-1');
    const setHedgeMode = vi.fn();
    const positionRows = [
      { symbol: 'SOLUSDT', positionAmt: '2', entryPrice: '100', updateTime: 0 },
    ];
    const signedGet = vi.fn().mockImplementation(async (path: string, params?: Record<string, string>) => {
      if (path === '/fapi/v1/positionSide/dual') return { dualSidePosition: false };
      if (path === '/fapi/v2/positionRisk') return params?.symbol === 'SOLUSDT' ? positionRows : [];
      if (path === '/fapi/v1/openAlgoOrders') return [];
      return [];
    });
    const exec = {
      binanceAdapter: { setHedgeMode, restoreFromExchange: restore },
      binanceRestClient: { signedGet },
    } as unknown as ExecutionRuntime;

    const r = await reconcilePositionsAtStartup(exec, cfg, ['SOLUSDT', 'ETHUSDT'], silentLog);

    expect(r.source).toBe('binance');
    expect(setHedgeMode).toHaveBeenCalledWith(false);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(r.positions).toEqual([
      { symbol: 'SOLUSDT', side: 'LONG', quantity: 2, entryPrice: 100 },
    ]);
  });

  it('THROWS in strict mode when Binance positionRisk fails for a symbol', async () => {
    const signedGet = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/fapi/v1/positionSide/dual') return { dualSidePosition: false };
      throw new Error('rate limited');
    });
    const exec = {
      binanceAdapter: { setHedgeMode: vi.fn(), restoreFromExchange: vi.fn() },
      binanceRestClient: { signedGet },
    } as unknown as ExecutionRuntime;
    await expect(
      reconcilePositionsAtStartup(exec, cfg, ['SOLUSDT'], silentLog, { strict: true }),
    ).rejects.toThrow(/startup_reconciliation_failed:binance:SOLUSDT:rate limited/);
  });

  it('returns source=none when no adapter is present', async () => {
    const r = await reconcilePositionsAtStartup({} as unknown as ExecutionRuntime, cfg, [], silentLog, { strict: false });
    expect(r.source).toBe('none');
    expect(r.positions).toHaveLength(0);
  });
});
