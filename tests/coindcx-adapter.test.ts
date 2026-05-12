import nock from 'nock';
import { describe, expect, it, afterEach } from 'vitest';
import { CoinDcxFuturesClient } from '../src/coindcx/futures-client';
import { CoinDcxExecutionAdapter } from '../src/execution/coindcx-adapter';

afterEach(() => {
  nock.cleanAll();
});

const makeClient = (): CoinDcxFuturesClient => {
  return new CoinDcxFuturesClient({
    apiKey: 'k', apiSecret: 's',
    apiBaseUrl: 'https://api.coindcx.com',
    readOnly: false,
  });
}

describe('CoinDcxExecutionAdapter', () => {
  it('places leverage + create + tpsl with correct payloads', async () => {
    let levBody: Record<string, unknown> | null = null;
    let createBody: Record<string, unknown> | null = null;
    let tpslBody: Record<string, unknown> | null = null;

    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/positions/update_leverage', (body: Record<string, unknown>) => {
        levBody = body;
        return true;
      })
      .reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/orders/create', (body: Record<string, unknown>) => {
        createBody = body;
        return true;
      })
      .reply(200, { id: 'ord1' })
      .post('/exchange/v1/derivatives/futures/positions/create_tpsl', (body: Record<string, unknown>) => {
        tpslBody = body;
        return true;
      })
      .reply(200, { ok: true });

    const adapter = new CoinDcxExecutionAdapter({
      client: makeClient(),
      marginCurrency: 'USDT',
      takerFee: 0.0005,
      fundingFeeEst: 0.0001,
    });
    const out = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 0.5, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
      takeProfit: 110, stopLoss: 90,
    });
    expect(out.ok).toBe(true);
    expect(levBody!.pair).toBe('B-SOL_USDT');
    expect(levBody!.leverage).toBe(10);
    expect(createBody!.side).toBe('buy');
    expect(createBody!.order_type).toBe('market');
    expect(createBody!.total_quantity).toBe(0.5);
    expect(tpslBody!.side).toBe('sell');
    expect(tpslBody!.take_profit_price).toBe(110);
    expect(tpslBody!.stop_loss_price).toBe(90);
  });

  it('closePosition calls exit and returns ClosedPosition shape', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/positions/update_leverage').reply(200, {})
      .post('/exchange/v1/derivatives/futures/orders/create').reply(200, { id: 'ord1' })
      .post('/exchange/v1/derivatives/futures/positions/create_tpsl').reply(200, {})
      .post('/exchange/v1/derivatives/futures/positions/exit').reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{ avg_close_price: 110 }]);

    const adapter = new CoinDcxExecutionAdapter({
      client: makeClient(),
      marginCurrency: 'USDT',
      takerFee: 0.0005,
      fundingFeeEst: 0.0001,
    });
    const open = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
      takeProfit: 110, stopLoss: 90,
    });
    expect(open.ok).toBe(true);
    const closed = await adapter.closePosition(open.orderId, 'TP');
    expect(closed.side).toBe('LONG');
    expect(closed.entryPrice).toBe(100);
    expect(closed.exitPrice).toBe(110);
    expect(closed.quantity).toBe(1);
    expect(closed.reason).toBe('TP');
    expect(closed.grossUsdt).toBeCloseTo(10, 6);
    expect(closed.feesUsdt).toBeGreaterThan(0);
    expect(closed.netUsdt).toBeCloseTo(closed.grossUsdt - closed.feesUsdt - closed.fundingUsdt, 6);
  });
});
