import { describe, expect, it, vi } from 'vitest';
import type { BinanceRestClient } from '../src/binance/rest-client';
import { getIncomeHistory, getCommissionRate } from '../src/binance/rest-trade';

describe('getIncomeHistory', () => {
  it('calls signed GET with symbol and incomeType filters', async () => {
    const signedGet = vi.fn().mockResolvedValue([
      { symbol: 'SOLUSDT', incomeType: 'REALIZED_PNL', income: '12.5', asset: 'USDT', time: 1700000000000, tranId: 1, tradeId: '' },
    ]);
    const client = { signedGet } as unknown as BinanceRestClient;
    const rows = await getIncomeHistory(client, { symbol: 'solusdt', incomeType: 'REALIZED_PNL', limit: 100 });
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/income', {
      symbol: 'SOLUSDT',
      incomeType: 'REALIZED_PNL',
      limit: 100,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].income).toBe('12.5');
  });

  it('works with no params', async () => {
    const signedGet = vi.fn().mockResolvedValue([]);
    const client = { signedGet } as unknown as BinanceRestClient;
    await getIncomeHistory(client);
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/income', {});
  });

  it('passes startTime and endTime for pagination', async () => {
    const signedGet = vi.fn().mockResolvedValue([]);
    const client = { signedGet } as unknown as BinanceRestClient;
    await getIncomeHistory(client, { startTime: 1000, endTime: 2000 });
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/income', { startTime: 1000, endTime: 2000 });
  });
});

describe('getCommissionRate', () => {
  it('returns maker and taker rates for symbol', async () => {
    const signedGet = vi.fn().mockResolvedValue({
      symbol: 'SOLUSDT',
      makerCommissionRate: '0.00020000',
      takerCommissionRate: '0.00040000',
    });
    const client = { signedGet } as unknown as BinanceRestClient;
    const r = await getCommissionRate(client, 'solusdt');
    expect(signedGet).toHaveBeenCalledWith('/fapi/v1/commissionRate', { symbol: 'SOLUSDT' });
    expect(r.makerCommissionRate).toBe('0.00020000');
    expect(r.takerCommissionRate).toBe('0.00040000');
  });
});
