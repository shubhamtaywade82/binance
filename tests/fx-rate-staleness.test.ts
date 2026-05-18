import { describe, expect, it } from 'vitest';
import { FxRateService } from '../src/services/fx-rate';

const fakeOk = (rate: number): typeof fetch =>
  (async () => new Response(JSON.stringify({ symbol: 'USDTINR', price: String(rate) }))) as unknown as typeof fetch;

describe('FxRateService.isRateStale (M-17)', () => {
  it('reports stale until the first successful fetch', () => {
    const svc = new FxRateService({
      source: 'binance', refreshSec: 60, fallbackInrPerUsdt: 85,
      fetchImpl: fakeOk(86),
    });
    expect(svc.isRateStale()).toBe(true);
    expect(svc.snapshot().stale).toBe(true);
  });

  it('reports fresh immediately after a successful refresh', async () => {
    const svc = new FxRateService({
      source: 'binance', refreshSec: 60, fallbackInrPerUsdt: 85,
      fetchImpl: fakeOk(86),
    });
    await svc.refreshOnce();
    expect(svc.isRateStale()).toBe(false);
    expect(svc.snapshot().stale).toBe(false);
    expect(svc.getInrPerUsdt()).toBe(86);
  });

  it('reports stale again when the cached rate exceeds maxAgeMs', async () => {
    const svc = new FxRateService({
      source: 'binance', refreshSec: 60, fallbackInrPerUsdt: 85,
      fetchImpl: fakeOk(86),
      maxAgeMs: 100,
    });
    await svc.refreshOnce();
    expect(svc.isRateStale()).toBe(false);

    // Pretend now is past the maxAge window.
    const futureNow = Date.now() + 500;
    expect(svc.isRateStale(futureNow)).toBe(true);
  });

  it('source=fixed is never stale', () => {
    const svc = new FxRateService({
      source: 'fixed', refreshSec: 60, fallbackInrPerUsdt: 85,
    });
    expect(svc.isRateStale()).toBe(false);
    expect(svc.snapshot().stale).toBe(false);
  });

  it('default maxAgeMs is 10 minutes', async () => {
    const svc = new FxRateService({
      source: 'binance', refreshSec: 60, fallbackInrPerUsdt: 85,
      fetchImpl: fakeOk(86),
    });
    await svc.refreshOnce();
    expect(svc.isRateStale(Date.now() + 9 * 60_000)).toBe(false);
    expect(svc.isRateStale(Date.now() + 11 * 60_000)).toBe(true);
  });
});
