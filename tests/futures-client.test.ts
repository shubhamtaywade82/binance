import nock from 'nock';
import { describe, expect, it, afterEach } from 'vitest';
import { CoinDcxFuturesClient } from '../src/coindcx/futures-client';

afterEach(() => {
  nock.cleanAll();
});

describe('CoinDcxFuturesClient', () => {
  it('blocks writes when readOnly', async () => {
    const client = new CoinDcxFuturesClient({
      apiKey: 'k',
      apiSecret: 's',
      apiBaseUrl: 'https://api.coindcx.com',
      readOnly: true,
    });
    await expect(client.createFuturesOrder({ pair: 'B-SOL_USDT' })).rejects.toThrow(/Read-only/);
  });

  it('posts signed create order when readOnly is false', async () => {
    const scope = nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create', (body: Record<string, unknown>) => {
        expect(body.pair).toBe('B-SOL_USDT');
        expect(body.side).toBe('buy');
        expect(body.order_type).toBe('market');
        expect(typeof body.timestamp).toBe('number');
        return true;
      })
      .reply(200, { id: 'ord1' });

    const client = new CoinDcxFuturesClient({
      apiKey: 'k',
      apiSecret: 'secret',
      apiBaseUrl: 'https://api.coindcx.com',
      readOnly: false,
    });

    const out = await client.createFuturesOrder({
      pair: 'B-SOL_USDT',
      side: 'buy',
      order_type: 'market',
      price: null,
      stop_price: null,
      total_quantity: 0.01,
      notification: 'no_notification',
    });
    expect(out).toEqual({ id: 'ord1' });
    scope.done();
  });
});
