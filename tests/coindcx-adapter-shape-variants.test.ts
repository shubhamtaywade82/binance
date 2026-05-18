import nock from 'nock';
import { describe, expect, it, afterEach } from 'vitest';
import { CoinDcxFuturesClient } from '../src/coindcx/futures-client';
import { CoinDcxExecutionAdapter } from '../src/execution/coindcx-adapter';

afterEach(() => { nock.cleanAll(); });

const client = (): CoinDcxFuturesClient => new CoinDcxFuturesClient({
  apiKey: 'k', apiSecret: 's', apiBaseUrl: 'https://api.coindcx.com', readOnly: false,
});

const adapter = () => new CoinDcxExecutionAdapter({
  client: client(),
  marginCurrency: 'USDT',
  takerFee: 0.0005,
  fundingFeeEst: 0.0001,
  skipLeverageUpdate: true,
});

/**
 * M-14: CoinDCX returns subtly different response shapes across endpoints and
 * API versions. The adapter's close + reconcile paths look up the exit price
 * under several candidate keys (avg_close_price / avgClosePrice / mark_price /
 * markPrice / last_price). These tests pin that contract so a real-world
 * shape mismatch doesn't slip past the existing tests' single-shape mocks.
 */
describe('CoinDcxExecutionAdapter response-shape variants (M-14)', () => {
  it('close exit price: avg_close_price (snake_case)', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(200, { id: 'o1' })
      .post('/exchange/v1/derivatives/futures/positions/exit').reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{ avg_close_price: 105 }]);
    const a = adapter();
    const open = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    expect(open.ok).toBe(true);
    const closed = await a.closePosition(open.orderId, 'TP');
    expect(closed.exitPrice).toBe(105);
  });

  it('close exit price: avgClosePrice (camelCase)', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(200, { id: 'o2' })
      .post('/exchange/v1/derivatives/futures/positions/exit').reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{ avgClosePrice: 105.5 }]);
    const a = adapter();
    const open = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    const closed = await a.closePosition(open.orderId, 'TP');
    expect(closed.exitPrice).toBe(105.5);
  });

  it('close exit price: falls back to mark_price', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(200, { id: 'o3' })
      .post('/exchange/v1/derivatives/futures/positions/exit').reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{ mark_price: 104.2 }]);
    const a = adapter();
    const open = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    const closed = await a.closePosition(open.orderId, 'TP');
    expect(closed.exitPrice).toBe(104.2);
  });

  it('close exit price: falls back to last_price', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(200, { id: 'o4' })
      .post('/exchange/v1/derivatives/futures/positions/exit').reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{ last_price: 103.9 }]);
    const a = adapter();
    const open = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    const closed = await a.closePosition(open.orderId, 'TP');
    expect(closed.exitPrice).toBe(103.9);
  });

  it('close exit price: keeps entry price when ALL exit fields are missing', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(200, { id: 'o5' })
      .post('/exchange/v1/derivatives/futures/positions/exit').reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{ side: 'buy' }]);
    const a = adapter();
    const open = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    const closed = await a.closePosition(open.orderId, 'TP');
    expect(closed.exitPrice).toBe(100); // fallback to entry, with no mark either
  });

  it('close exit price: uses the FIRST recognised key when multiple are present', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(200, { id: 'o6' })
      .post('/exchange/v1/derivatives/futures/positions/exit').reply(200, { ok: true })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{
        avg_close_price: 110, avgClosePrice: 111, mark_price: 112, last_price: 113,
      }]);
    const a = adapter();
    const open = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    const closed = await a.closePosition(open.orderId, 'TP');
    // Adapter scans the candidate list in order; the first finite-positive
    // value wins. avg_close_price comes first.
    expect(closed.exitPrice).toBe(110);
  });

  it('reconciliation match: reads avg_price from a positions list row', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(500, { message: 'rejected' })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [{
        side: 'buy', active_pos: 1, avg_price: 99.75,
      }]);
    const a = adapter();
    const r = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100, idempotencyKey: 'evt-shape-1',
    });
    expect(r.ok).toBe(true);
    expect(r.fill.price).toBe(99.75);
  });

  it('reconciliation match: positions list returned as single object (not array)', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(500, { message: 'rejected' })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, {
        side: 'buy', active_pos: 1, avg_price: 99.5,
      });
    const a = adapter();
    const r = await a.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 5,
      marginCurrency: 'USDT', referencePrice: 100, idempotencyKey: 'evt-shape-2',
    });
    // getFuturesPositionByPair sometimes returns a single object; the
    // adapter normalises via `Array.isArray ? : [data]`.
    expect(r.ok).toBe(true);
    expect(r.fill.price).toBe(99.5);
  });
});
