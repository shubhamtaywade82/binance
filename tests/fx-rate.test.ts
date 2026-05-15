import { describe, expect, it, vi } from 'vitest';
import { FxRateService } from '../src/services/fx-rate';

const okResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body } as unknown as Response);

const errResponse = (): Response =>
  ({ ok: false, json: async () => ({ code: -1, msg: 'bad' }) } as unknown as Response);

describe('FxRateService', () => {
  it('parses USDTINR price from Binance', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(String(url)).toContain('symbol=USDTINR');
      return okResponse({ symbol: 'USDTINR', price: '88.42' });
    }) as unknown as typeof fetch;

    const svc = new FxRateService({
      source: 'binance',
      refreshSec: 600,
      fallbackInrPerUsdt: 85,
      fetchImpl,
    });
    await svc.refreshOnce();
    expect(svc.getInrPerUsdt()).toBeCloseTo(88.42, 4);
    const snap = svc.snapshot();
    expect(snap.source).toBe('binance');
    expect(snap.stale).toBe(false);
  });

  it('falls back to BUSDINR when USDTINR is unavailable', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('USDTINR')) return errResponse();
      return okResponse({ symbol: 'BUSDINR', price: '87.10' });
    }) as unknown as typeof fetch;

    const svc = new FxRateService({
      source: 'binance',
      refreshSec: 600,
      fallbackInrPerUsdt: 85,
      fetchImpl,
    });
    await svc.refreshOnce();
    expect(svc.getInrPerUsdt()).toBeCloseTo(87.10, 4);
  });

  it('parses CoinDCX USDTINR last_price', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse([
        { market: 'BTCINR', last_price: '5000000' },
        { market: 'USDTINR', last_price: '86.77' },
      ]),
    ) as unknown as typeof fetch;

    const svc = new FxRateService({
      source: 'coindcx',
      refreshSec: 600,
      fallbackInrPerUsdt: 85,
      fetchImpl,
    });
    await svc.refreshOnce();
    expect(svc.getInrPerUsdt()).toBeCloseTo(86.77, 4);
  });

  it('keeps fallback when fetch throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const svc = new FxRateService({
      source: 'binance',
      refreshSec: 600,
      fallbackInrPerUsdt: 85,
      fetchImpl,
    });
    await svc.refreshOnce();
    expect(svc.getInrPerUsdt()).toBe(85);
    expect(svc.snapshot().stale).toBe(true);
  });

  it('fixed source returns the static fallback without fetching', async () => {
    const fetchImpl = vi.fn(async () => okResponse({})) as unknown as typeof fetch;
    const svc = new FxRateService({
      source: 'fixed',
      refreshSec: 600,
      fallbackInrPerUsdt: 90,
      fetchImpl,
    });
    await svc.start();
    expect(svc.getInrPerUsdt()).toBe(90);
    expect(svc.snapshot().stale).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    svc.stop();
  });
});
