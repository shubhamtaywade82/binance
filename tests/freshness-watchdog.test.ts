import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { FreshnessWatchdog } from '../src/core/execution/freshness-watchdog';

const ev = (type: string, symbol: string, payload: Record<string, unknown> = {}) => ({
  id: `${type}-${symbol}-${Math.random()}`,
  type,
  ts: 0,
  source: 'test',
  symbol,
  payload,
});

describe('FreshnessWatchdog (C-7)', () => {
  it('publishes system.stale once when all sources for a symbol exceed staleAfterMs', () => {
    const bus = new EventBus();
    let mockNow = 1_000_000;
    const wd = new FreshnessWatchdog(bus, {
      staleAfterMs: 1_000,
      checkIntervalMs: 100,
      now: () => mockNow,
    });
    const stale: any[] = [];
    bus.subscribe('system.stale', (e) => stale.push(e));

    // T=0: feed one bookticker for SOLUSDT
    bus.publish(ev('market.bookticker', 'SOLUSDT', { bestBidPrice: 100, bestAskPrice: 100.1 }));
    expect(stale).toHaveLength(0);

    // T=+2s: no further events, should fire stale on scan
    mockNow += 2_000;
    wd.scanNow();
    expect(stale).toHaveLength(1);
    expect(stale[0].symbol).toBe('SOLUSDT');
    expect(stale[0].payload.sources).toContain('market.bookticker');
    expect(wd.staleSymbols()).toEqual(['SOLUSDT']);

    // Scanning again with no recovery should NOT republish.
    wd.scanNow();
    expect(stale).toHaveLength(1);
  });

  it('publishes system.fresh when any source recovers', () => {
    const bus = new EventBus();
    let mockNow = 1_000_000;
    const wd = new FreshnessWatchdog(bus, {
      staleAfterMs: 1_000,
      checkIntervalMs: 100,
      now: () => mockNow,
    });
    const stale: any[] = [];
    const fresh: any[] = [];
    bus.subscribe('system.stale', (e) => stale.push(e));
    bus.subscribe('system.fresh', (e) => fresh.push(e));

    bus.publish(ev('market.kline.closed', 'SOLUSDT', { close: 100 }));
    mockNow += 2_000;
    wd.scanNow();
    expect(stale).toHaveLength(1);
    expect(fresh).toHaveLength(0);

    // Recovery
    bus.publish(ev('market.kline.closed', 'SOLUSDT', { close: 102 }));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].payload.recoveredSource).toBe('market.kline.closed');
    expect(wd.staleSymbols()).toEqual([]);

    // Going stale again after recovery should publish again.
    mockNow += 2_000;
    wd.scanNow();
    expect(stale).toHaveLength(2);
  });

  it('tracks symbols independently — staleness on SOLUSDT does not flag ETHUSDT', () => {
    const bus = new EventBus();
    let mockNow = 1_000_000;
    const wd = new FreshnessWatchdog(bus, { staleAfterMs: 1_000, now: () => mockNow });
    const stale: any[] = [];
    bus.subscribe('system.stale', (e) => stale.push(e));

    bus.publish(ev('market.mark', 'SOLUSDT', { markPrice: 100 }));
    bus.publish(ev('market.mark', 'ETHUSDT', { markPrice: 3000 }));

    mockNow += 2_000;
    // ETHUSDT recovers, SOL stays silent
    bus.publish(ev('market.mark', 'ETHUSDT', { markPrice: 3001 }));
    wd.scanNow();

    expect(stale.map((e) => e.symbol)).toEqual(['SOLUSDT']);
  });

  it('does not flag stale when fewer than all sources have aged out (one fresh source keeps the symbol healthy)', () => {
    const bus = new EventBus();
    let mockNow = 1_000_000;
    const wd = new FreshnessWatchdog(bus, { staleAfterMs: 1_000, now: () => mockNow });
    const stale: any[] = [];
    bus.subscribe('system.stale', (e) => stale.push(e));

    bus.publish(ev('market.kline.closed', 'SOLUSDT', { close: 100 }));
    mockNow += 500;
    bus.publish(ev('market.bookticker', 'SOLUSDT', { bestBidPrice: 100, bestAskPrice: 100.1 }));

    mockNow += 700; // kline is 1200ms old (stale), bookticker is 700ms old (fresh)
    wd.scanNow();
    expect(stale).toHaveLength(0);

    mockNow += 600; // bookticker is now 1300ms old too
    wd.scanNow();
    expect(stale).toHaveLength(1);
  });

  it('does not flag symbols that have never published anything', () => {
    const bus = new EventBus();
    let mockNow = 1_000_000;
    const wd = new FreshnessWatchdog(bus, { staleAfterMs: 1_000, now: () => mockNow });
    const stale: any[] = [];
    bus.subscribe('system.stale', (e) => stale.push(e));

    mockNow += 5_000;
    wd.scanNow();
    expect(stale).toHaveLength(0);
  });
});
