import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { RiskEngine } from '../src/core/risk/risk-engine';
import type { AppConfig } from '../src/config';

const cfg = {
  MAX_TOTAL_EXPOSURE_USDT: 100_000,
  MAX_OPEN_SYMBOLS: 5,
  MAX_OPEN_POSITIONS: 5,
  MAX_NOTIONAL_USDT: 0,
  SIGNAL_ALLOCATOR_ENABLED: false,
} as unknown as AppConfig;

const fillEvent = (symbol: string, opts: { quantity?: number; price?: number; reason?: string } = {}) => ({
  id: `fill-${symbol}-${Math.random()}`,
  type: 'execution.order.filled',
  ts: 0,
  source: 'test',
  symbol,
  payload: {
    orderId: `o-${symbol}`,
    symbol,
    side: 'LONG',
    quantity: opts.quantity ?? 1,
    price: opts.price ?? 100,
    reason: opts.reason,
  },
});

describe('RiskEngine STARTUP_REARM skip (C-9)', () => {
  it('does NOT double-count notional when a synthetic re-arm fill arrives after seedPositions', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    engine.seedPositions([{ symbol: 'SOLUSDT', side: 'LONG', quantity: 1, entryPrice: 100 }]);
    expect(engine.getExposure().total).toBe(100);
    expect(engine.getExposure().symbols).toBe(1);

    bus.publish(fillEvent('SOLUSDT', { reason: 'STARTUP_REARM' }));

    expect(engine.getExposure().total).toBe(100); // unchanged
    expect(engine.getExposure().symbols).toBe(1);
  });

  it('still processes regular (non-rearm) fills normally', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fillEvent('SOLUSDT'));
    expect(engine.getExposure().total).toBe(100);
  });

  it('lets the new event flow through to other subscribers (e.g. exit managers)', () => {
    const bus = new EventBus();
    new RiskEngine(cfg, bus);
    const observers: any[] = [];
    bus.subscribe('execution.order.filled', (e) => observers.push(e));
    bus.publish(fillEvent('SOLUSDT', { reason: 'STARTUP_REARM' }));
    expect(observers).toHaveLength(1);
  });
});
