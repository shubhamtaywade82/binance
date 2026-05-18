import { describe, expect, it, vi } from 'vitest';
import { BinanceServerClock } from '../src/binance/server-clock';

const respondWithServerTime = (serverTime: number): typeof fetch =>
  (async () => new Response(JSON.stringify({ serverTime }))) as unknown as typeof fetch;

const respondNotOk = (): typeof fetch =>
  (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;

describe('BinanceServerClock (M-8)', () => {
  it('starts with zero offset until first sync', () => {
    const clock = new BinanceServerClock({
      baseUrl: 'https://fapi.binance.com',
      fetchImpl: respondWithServerTime(0),
    });
    expect(clock.getOffsetMs()).toBe(0);
    expect(clock.ageOfLastSyncMs()).toBe(Infinity);
  });

  it('updates offset = serverTime - localNow after a successful sync', async () => {
    // Pretend the exchange is ahead by ~5s.
    const future = Date.now() + 5_000;
    const clock = new BinanceServerClock({
      baseUrl: 'https://fapi.binance.com',
      fetchImpl: respondWithServerTime(future),
    });
    await clock.syncOnce();
    expect(clock.getOffsetMs()).toBeGreaterThanOrEqual(4_900);
    expect(clock.getOffsetMs()).toBeLessThanOrEqual(5_100);
    expect(clock.ageOfLastSyncMs()).toBeLessThan(100);
  });

  it('binanceNow() applies the offset', async () => {
    const future = Date.now() + 5_000;
    const clock = new BinanceServerClock({
      baseUrl: 'https://fapi.binance.com',
      fetchImpl: respondWithServerTime(future),
    });
    await clock.syncOnce();
    const now = clock.binanceNow();
    expect(now).toBeGreaterThanOrEqual(future - 100);
    expect(now).toBeLessThanOrEqual(future + 100);
  });

  it('keeps the previous offset when a sync fails (best-effort)', async () => {
    const clock = new BinanceServerClock({
      baseUrl: 'https://fapi.binance.com',
      fetchImpl: respondWithServerTime(Date.now() + 5_000),
    });
    await clock.syncOnce();
    const offsetBefore = clock.getOffsetMs();

    // Now point at a 500-returning endpoint.
    (clock as any).fetchImpl = respondNotOk();
    await clock.syncOnce();
    expect(clock.getOffsetMs()).toBe(offsetBefore);
  });

  it('start() / stop() are idempotent and stop clears the timer', async () => {
    const clock = new BinanceServerClock({
      baseUrl: 'https://fapi.binance.com',
      fetchImpl: respondWithServerTime(Date.now()),
      intervalMs: 60_000,
    });
    await clock.start();
    clock.stop();
    expect(() => clock.stop()).not.toThrow();
  });

  it('enforces a minimum interval of 10s', () => {
    const clock = new BinanceServerClock({
      baseUrl: 'https://fapi.binance.com',
      intervalMs: 1, // attempted absurd value
      fetchImpl: respondWithServerTime(0),
    });
    // Internal value should have been clamped to 10s.
    expect((clock as any).intervalMs).toBe(10_000);
  });
});
