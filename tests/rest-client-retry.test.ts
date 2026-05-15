import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/binance/rest-retry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/binance/rest-retry')>();
  return {
    ...actual,
    sleepMs: vi.fn(() => Promise.resolve()),
  };
});

import { BinanceRestClient } from '../src/binance/rest-client';
import { sleepMs } from '../src/binance/rest-retry';
import { createListenKey } from '../src/binance/rest-trade';

const sleepMsMock = vi.mocked(sleepMs);

afterEach(() => {
  nock.cleanAll();
  vi.clearAllMocks();
});

describe('BinanceRestClient retry', () => {
  it('retries public GET on 429 then succeeds', async () => {
    nock('https://fapi.binance.com')
      .get('/fapi/v1/ping')
      .reply(429, { code: -1003, msg: 'Way too many requests' })
      .get('/fapi/v1/ping')
      .reply(200, {});

    const client = new BinanceRestClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://fapi.binance.com',
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
    });

    await expect(client.publicGet('/fapi/v1/ping')).resolves.toEqual({});
    expect(sleepMsMock).toHaveBeenCalledTimes(1);
  });

  it('retries signed POST on 503 then returns listenKey', async () => {
    nock('https://fapi.binance.com')
      .post('/fapi/v1/listenKey')
      .reply(503, { msg: 'Service unavailable' })
      .post('/fapi/v1/listenKey')
      .reply(200, { listenKey: 'abc123' });

    const client = new BinanceRestClient({
      apiKey: 'k',
      apiSecret: 'secret',
      baseUrl: 'https://fapi.binance.com',
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });

    const key = await createListenKey(client);
    expect(key).toBe('abc123');
    expect(sleepMsMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 400', async () => {
    nock('https://fapi.binance.com').get('/fapi/v1/ping').reply(400, { code: -1102, msg: 'Mandatory param' });

    const client = new BinanceRestClient({
      apiKey: 'k',
      apiSecret: 's',
      baseUrl: 'https://fapi.binance.com',
      retry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 2 },
    });

    await expect(client.publicGet('/fapi/v1/ping')).rejects.toMatchObject({
      name: 'BinanceRestError',
      statusCode: 400,
    });
    expect(sleepMsMock).not.toHaveBeenCalled();
  });
});
