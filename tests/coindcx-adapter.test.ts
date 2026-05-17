import nock from 'nock';
import { describe, expect, it, afterEach } from 'vitest';
import { CoinDcxFuturesClient } from '../src/coindcx/futures-client';
import { CoinDcxExecutionAdapter, deriveClientOrderId } from '../src/execution/coindcx-adapter';

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
    // client_order_id MUST be present on the entry call (idempotency primitive).
    expect(typeof createBody!.client_order_id).toBe('string');
    expect(String(createBody!.client_order_id)).toMatch(/^bot_/);
    // TP/SL payload should carry a derived idempotency tag so the bracket call is also dedupe-able.
    expect(tpslBody!.side).toBe('sell');
    expect(tpslBody!.take_profit_price).toBe(110);
    expect(tpslBody!.stop_loss_price).toBe(90);
    expect(typeof tpslBody!.client_order_id).toBe('string');
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
    expect(closed.leverage).toBe(10);
    expect(closed.grossUsdt).toBeCloseTo(10, 6);
    expect(closed.feesUsdt).toBeGreaterThan(0);
    expect(closed.netUsdt).toBeCloseTo(closed.grossUsdt - closed.feesUsdt - closed.fundingUsdt, 6);
  });

  it('deriveClientOrderId is deterministic for the same idempotencyKey across time', () => {
    const req = {
      pair: 'B-SOL_USDT', side: 'LONG' as const, quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100, idempotencyKey: 'evt-abc-123',
    };
    const a = deriveClientOrderId(req, 1_000_000);
    const b = deriveClientOrderId(req, 1_000_000 + 60_000); // 60s later
    expect(a).toBe(b);
    expect(a).toMatch(/^bot_[a-f0-9]{28}$/);
  });

  it('deriveClientOrderId falls back to time-bucketed hash when no idempotencyKey', () => {
    const req = {
      pair: 'B-SOL_USDT', side: 'LONG' as const, quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    };
    const sameBucket = deriveClientOrderId(req, 1_000_000);
    const sameBucket2 = deriveClientOrderId(req, 1_000_000 + 2_000); // <5s
    const diffBucket = deriveClientOrderId(req, 1_000_000 + 6_000); // ≥5s
    expect(sameBucket).toBe(sameBucket2);
    expect(sameBucket).not.toBe(diffBucket);
  });

  it('returns cached result for duplicate placeOrder with the same idempotencyKey', async () => {
    let createCalls = 0;

    // Only ONE create call is expected even though we call placeOrder twice.
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/positions/update_leverage').reply(200, {})
      .post('/exchange/v1/derivatives/futures/orders/create', () => {
        createCalls += 1;
        return true;
      })
      .reply(200, { id: 'ord1' });

    const adapter = new CoinDcxExecutionAdapter({
      client: makeClient(),
      marginCurrency: 'USDT', takerFee: 0.0005, fundingFeeEst: 0.0001,
      skipLeverageUpdate: true,
    });
    const req = {
      pair: 'B-SOL_USDT', side: 'LONG' as const, quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100, idempotencyKey: 'dedupe-key-1',
    };
    const first = await adapter.placeOrder(req);
    const second = await adapter.placeOrder(req);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    expect(createCalls).toBe(1); // CRITICAL: no duplicate exchange order
  });

  it('reconciles a successful fill after the create call errors but the order landed', async () => {
    // create errors (simulating a transient server-side failure where the bot
    // cannot know whether the order landed), then positions endpoint reveals a
    // matching position — the worst real-world scenario for non-idempotent POSTs.
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(500, { message: 'internal server error' })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, [
        { side: 'buy', active_pos: 1, avg_price: 99.5 },
      ]);

    const adapter = new CoinDcxExecutionAdapter({
      client: makeClient(),
      marginCurrency: 'USDT', takerFee: 0.0005, fundingFeeEst: 0.0001,
      skipLeverageUpdate: true,
    });
    const out = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100, idempotencyKey: 'reco-1',
    });

    expect(out.ok).toBe(true);
    expect(out.fill.price).toBe(99.5); // recovered from exchange truth, not refPrice
    expect(out.fill.feeUsdt).toBeGreaterThan(0);
    expect(adapter.getOpenPositions).toBeDefined();
  });

  it('returns ok=false when create errors and no matching position is found', async () => {
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create').reply(500, { message: 'internal server error' })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, []);

    const adapter = new CoinDcxExecutionAdapter({
      client: makeClient(),
      marginCurrency: 'USDT', takerFee: 0.0005, fundingFeeEst: 0.0001,
      skipLeverageUpdate: true,
    });
    const out = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100, idempotencyKey: 'reco-fail-1',
    });

    expect(out.ok).toBe(false);
    expect(out.error ?? '').toMatch(/^submit_failed:/);
  });

  it('caches the failed-with-no-recovery result so retries do not re-hit the exchange', async () => {
    let createCalls = 0;
    nock('https://api.coindcx.com')
      .post('/exchange/v1/derivatives/futures/orders/create', () => {
        createCalls += 1;
        return true;
      })
      .reply(500, { message: 'internal server error' })
      .post('/exchange/v1/derivatives/futures/positions').reply(200, []);

    const adapter = new CoinDcxExecutionAdapter({
      client: makeClient(),
      marginCurrency: 'USDT', takerFee: 0.0005, fundingFeeEst: 0.0001,
      skipLeverageUpdate: true,
    });
    const req = {
      pair: 'B-SOL_USDT', side: 'LONG' as const, quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100, idempotencyKey: 'reco-cache-1',
    };
    const first = await adapter.placeOrder(req);
    const second = await adapter.placeOrder(req);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(second.orderId).toBe(first.orderId);
    expect(createCalls).toBe(1); // failure cached; no second exchange call
  });
});
