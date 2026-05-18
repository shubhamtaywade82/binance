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

const fill = (
  symbol: string,
  opts: { orderId?: string; quantity?: number; price?: number; side?: 'LONG' | 'SHORT'; reason?: string; reduceOnly?: boolean } = {},
) => ({
  id: `fill-${symbol}-${Math.random()}`,
  type: 'execution.order.filled',
  ts: 0,
  source: 'test',
  symbol,
  payload: {
    orderId: opts.orderId ?? `o-${symbol}`,
    symbol,
    side: opts.side ?? 'LONG',
    quantity: opts.quantity ?? 1,
    price: opts.price ?? 100,
    reason: opts.reason,
    reduceOnly: opts.reduceOnly,
  },
});

const closed = (symbol: string, orderId?: string, payload: Record<string, unknown> = {}) => ({
  id: `close-${symbol}-${Math.random()}`,
  type: 'execution.position.closed',
  ts: 0,
  source: 'test',
  symbol,
  payload: { orderId: orderId ?? `o-${symbol}`, symbol, ...payload },
});

describe('RiskEngine fill bookkeeping correctness (H-2 / H-3)', () => {
  it('H-3: duplicate fill events with the same orderId do NOT double-count notional', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('SOLUSDT', { orderId: 'o-1', quantity: 1, price: 100 }));
    bus.publish(fill('SOLUSDT', { orderId: 'o-1', quantity: 1, price: 100 })); // same id
    bus.publish(fill('SOLUSDT', { orderId: 'o-1', quantity: 1, price: 100 })); // same id
    expect(engine.getExposure().total).toBe(100);
  });

  it('H-2: PARTIAL_TP / TRAIL / SL fills do NOT accumulate notional', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('SOLUSDT', { orderId: 'o-open', quantity: 2, price: 100 }));
    expect(engine.getExposure().total).toBe(200);

    bus.publish(fill('SOLUSDT', { orderId: 'o-tp1', quantity: 1, price: 105, reason: 'PARTIAL_TP' }));
    bus.publish(fill('SOLUSDT', { orderId: 'o-trail', quantity: 1, price: 103, reason: 'TRAIL' }));
    bus.publish(fill('SOLUSDT', { orderId: 'o-sl', quantity: 1, price: 99, reason: 'SL' }));

    // Notional unchanged — these are reducing fills.
    expect(engine.getExposure().total).toBe(200);
  });

  it('H-2: reduceOnly=true fills do NOT accumulate notional even without a known reason', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('SOLUSDT', { orderId: 'o-open', quantity: 2, price: 100 }));
    bus.publish(fill('SOLUSDT', { orderId: 'o-reduce', quantity: 1, price: 105, reduceOnly: true }));
    expect(engine.getExposure().total).toBe(200);
  });

  it('H-2: opposite-side fill on an existing position is treated as a no-op (safety)', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('SOLUSDT', { orderId: 'o-long', quantity: 1, price: 100, side: 'LONG' }));
    bus.publish(fill('SOLUSDT', { orderId: 'o-short', quantity: 1, price: 100, side: 'SHORT' }));
    // Existing LONG remains; opposite SHORT fill is defensively ignored.
    const exposure = engine.getExposure();
    expect(exposure.total).toBe(100);
    expect(exposure.positions.get('SOLUSDT')?.side).toBe('LONG');
  });

  it('H-3: orderId set is cleared on position close so re-opening works', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('SOLUSDT', { orderId: 'o-1', quantity: 1, price: 100 }));
    bus.publish(closed('SOLUSDT', 'o-1'));
    expect(engine.getExposure().total).toBe(0);
    // Re-open with a fresh order — must NOT be blocked by stale dedupe entry.
    bus.publish(fill('SOLUSDT', { orderId: 'o-2', quantity: 1, price: 100 }));
    expect(engine.getExposure().total).toBe(100);
  });

  it('keeps remaining exposure after a PARTIAL_TP close event', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('SOLUSDT', { orderId: 'o-1', quantity: 4, price: 100 }));

    bus.publish(closed('SOLUSDT', 'o-1', { reason: 'PARTIAL_TP', quantity: 1 }));

    const exposure = engine.getExposure();
    expect(exposure.total).toBe(300);
    expect(exposure.positions.get('SOLUSDT')).toMatchObject({
      quantity: 3,
      notional: 300,
      side: 'LONG',
    });
  });
});

const orderRequested = (symbol: string, side: 'LONG' | 'SHORT', quantity: number, price: number) => ({
  id: `req-${symbol}-${Math.random()}`,
  type: 'execution.order.requested',
  ts: 0,
  source: 'test',
  symbol,
  payload: { symbol, side, quantity, price, type: 'MARKET' },
});

describe('RiskEngine pyramiding notional cap (H-7)', () => {
  it('rejects a pyramid add whose total position notional would exceed MAX_NOTIONAL_USDT', () => {
    const bus = new EventBus();
    const engine = new RiskEngine({ ...cfg, MAX_NOTIONAL_USDT: 150 } as unknown as AppConfig, bus);
    bus.publish(orderRequested('SOLUSDT', 'LONG', 1, 100));
    // Simulate the fill of the first leg so the position is recorded.
    bus.publish(fill('SOLUSDT', { orderId: 'leg-1', quantity: 1, price: 100 }));

    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));

    // Pyramid add: existing 100 + new 80 = 180 > cap of 150 → reject.
    bus.publish(orderRequested('SOLUSDT', 'LONG', 0.8, 100));
    expect(rejections).toHaveLength(1);
    expect(rejections[0].payload.reason).toBe('MAX_PER_ORDER_NOTIONAL_EXCEEDED');
    void engine;
  });

  it('accepts a single-leg order whose notional is below MAX_NOTIONAL_USDT', () => {
    const bus = new EventBus();
    new RiskEngine({ ...cfg, MAX_NOTIONAL_USDT: 150 } as unknown as AppConfig, bus);
    const accepted: any[] = [];
    bus.subscribe('execution.order.accepted', (e) => accepted.push(e));
    bus.publish(orderRequested('SOLUSDT', 'LONG', 1, 100));
    expect(accepted).toHaveLength(1);
  });
});
