import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { RiskEngine } from '../src/core/risk/risk-engine';
import type { AppConfig } from '../src/config';

const baseCfg = {
  MAX_TOTAL_EXPOSURE_USDT: 100_000,
  MAX_OPEN_SYMBOLS: 5,
  MAX_OPEN_POSITIONS: 5,
  MAX_NOTIONAL_USDT: 0,
  SIGNAL_ALLOCATOR_ENABLED: false,
} as unknown as AppConfig;

const orderRequested = (symbol: string, opts: Partial<{ side: 'LONG' | 'SHORT'; quantity: number; price: number }> = {}) => ({
  id: `req-${symbol}-${Math.random()}`,
  type: 'execution.order.requested',
  ts: 0,
  source: 'test',
  symbol,
  payload: {
    symbol,
    side: opts.side ?? 'LONG',
    quantity: opts.quantity ?? 1,
    price: opts.price ?? 100,
    type: 'MARKET',
  },
});

const stale = (symbol: string) => ({
  id: `stale-${symbol}-${Math.random()}`,
  type: 'system.stale',
  ts: 0,
  source: 'freshness-watchdog',
  symbol,
  payload: { symbol, sources: ['market.bookticker'], thresholdMs: 30_000 },
});

const fresh = (symbol: string) => ({
  id: `fresh-${symbol}-${Math.random()}`,
  type: 'system.fresh',
  ts: 0,
  source: 'freshness-watchdog',
  symbol,
  payload: { symbol, recoveredSource: 'market.bookticker' },
});

describe('RiskEngine stale-feed gate (C-7)', () => {
  it('rejects orders for a symbol while it is flagged stale', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(baseCfg, bus);
    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    const accepted: any[] = [];
    bus.subscribe('execution.order.accepted', (e) => accepted.push(e));

    bus.publish(stale('SOLUSDT'));
    bus.publish(orderRequested('SOLUSDT'));

    expect(engine.isStale('SOLUSDT')).toBe(true);
    expect(accepted).toHaveLength(0);
    expect(rejections).toHaveLength(1);
    expect(rejections[0].payload.reason).toBe('STALE_FEED');
  });

  it('accepts orders again once system.fresh arrives', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(baseCfg, bus);
    const rejections: any[] = [];
    const accepted: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.subscribe('execution.order.accepted', (e) => accepted.push(e));

    bus.publish(stale('SOLUSDT'));
    bus.publish(orderRequested('SOLUSDT'));
    expect(accepted).toHaveLength(0);

    bus.publish(fresh('SOLUSDT'));
    expect(engine.isStale('SOLUSDT')).toBe(false);

    bus.publish(orderRequested('SOLUSDT'));
    expect(accepted).toHaveLength(1);
  });

  it('only gates the stale symbol — other symbols pass freely', () => {
    const bus = new EventBus();
    new RiskEngine(baseCfg, bus);
    const accepted: any[] = [];
    bus.subscribe('execution.order.accepted', (e) => accepted.push(e));

    bus.publish(stale('SOLUSDT'));
    bus.publish(orderRequested('ETHUSDT'));
    bus.publish(orderRequested('BTCUSDT'));

    expect(accepted.map((e) => e.symbol)).toEqual(['ETHUSDT', 'BTCUSDT']);
  });
});
