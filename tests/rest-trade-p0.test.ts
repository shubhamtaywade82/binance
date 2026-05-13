import { describe, expect, it, vi } from 'vitest';
import { BinanceRestClient } from '../src/binance/rest-client';
import {
  getOrderRateLimit,
  getPositionSideDual,
  getUserTrades,
  setCountdownCancelAll,
} from '../src/binance/rest-trade';

describe('P0 Binance REST helpers', () => {
  it('getPositionSideDual calls signed GET', async () => {
    const signedGet = vi.fn().mockResolvedValue({ dualSidePosition: true });
    const client = { signedGet } as unknown as BinanceRestClient;
    const r = await getPositionSideDual(client);
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/positionSide/dual');
    expect(r.dualSidePosition).toBe(true);
  });

  it('getUserTrades passes symbol and limit', async () => {
    const signedGet = vi.fn().mockResolvedValue([]);
    const client = { signedGet } as unknown as BinanceRestClient;
    await getUserTrades(client, { symbol: 'solusdt', limit: 5 });
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/userTrades', {
      symbol: 'SOLUSDT',
      limit: 5,
    });
  });

  it('getOrderRateLimit calls signed GET', async () => {
    const signedGet = vi.fn().mockResolvedValue([
      { rateLimitType: 'ORDERS', interval: 'MINUTE', intervalNum: 1, limit: 1200, count: 3 },
    ]);
    const client = { signedGet } as unknown as BinanceRestClient;
    const rows = await getOrderRateLimit(client);
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/rateLimit/order');
    expect(rows[0]?.limit).toBe(1200);
  });

  it('setCountdownCancelAll posts countdownTime', async () => {
    const signedPost = vi.fn().mockResolvedValue({ countdownTime: '60000' });
    const client = { signedPost } as unknown as BinanceRestClient;
    await setCountdownCancelAll(client, { countdownTime: 60_000 });
    expect(signedPost).toHaveBeenCalledWith('/fapi/v1/countdownCancelAll', { countdownTime: 60_000 });
  });
});
