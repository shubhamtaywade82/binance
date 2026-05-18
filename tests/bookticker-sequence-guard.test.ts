import { describe, expect, it, vi } from 'vitest';
import { BinanceMultiplexWs } from '../src/binance/ws-multiplex';

const makeWs = (onBookTicker: ReturnType<typeof vi.fn>) => {
  // Construct without starting — we just exercise dispatchBookTicker via reflection.
  return new BinanceMultiplexWs(
    {
      baseWsUrl: 'wss://fstream.binance.com',
      product: 'usdm',
      symbols: ['SOLUSDT'],
      timeframes: ['1m'],
      useBookTicker: true,
    },
    { onBookTicker },
  );
};

describe('BinanceMultiplexWs bookTicker sequence guard (M-9)', () => {
  it('dispatches the first tick with a fresh updateId', () => {
    const cb = vi.fn();
    const ws = makeWs(cb);
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99', a: '100', B: '1', A: '1', u: 1, T: 0 });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0].updateId).toBe(1);
  });

  it('dispatches a monotonically-increasing tick', () => {
    const cb = vi.fn();
    const ws = makeWs(cb);
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99', a: '100', B: '1', A: '1', u: 1, T: 0 });
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99.5', a: '100.5', B: '1', A: '1', u: 2, T: 0 });
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('DROPS a tick whose updateId equals the previous (duplicate replay)', () => {
    const cb = vi.fn();
    const ws = makeWs(cb);
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99', a: '100', B: '1', A: '1', u: 5, T: 0 });
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '98', a: '99', B: '1', A: '1', u: 5, T: 0 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('DROPS a tick whose updateId is older than the last accepted (reorder)', () => {
    const cb = vi.fn();
    const ws = makeWs(cb);
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99', a: '100', B: '1', A: '1', u: 10, T: 0 });
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '98', a: '99', B: '1', A: '1', u: 5, T: 0 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].bestBid).toBe(99);
  });

  it('tracks updateIds PER SYMBOL — SOL gap does not block ETH', () => {
    const cb = vi.fn();
    const ws = makeWs(cb);
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99', a: '100', B: '1', A: '1', u: 10, T: 0 });
    (ws as any).dispatchBookTicker({ s: 'ETHUSDT', b: '3000', a: '3001', B: '1', A: '1', u: 1, T: 0 });
    (ws as any).dispatchBookTicker({ s: 'ETHUSDT', b: '3000.5', a: '3001.5', B: '1', A: '1', u: 2, T: 0 });
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('treats missing/zero updateId as fresh (legacy spot ticker variants)', () => {
    const cb = vi.fn();
    const ws = makeWs(cb);
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99', a: '100', B: '1', A: '1', T: 0 });
    (ws as any).dispatchBookTicker({ s: 'SOLUSDT', b: '99.1', a: '100.1', B: '1', A: '1', T: 0 });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
