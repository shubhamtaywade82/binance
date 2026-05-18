import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { RiskEngine } from '../src/core/risk/risk-engine';
import type { AppConfig } from '../src/config';

const cfg = {
  MAX_TOTAL_EXPOSURE_USDT: 1_000_000,
  MAX_OPEN_SYMBOLS: 10,
  MAX_OPEN_POSITIONS: 10,
  MAX_NOTIONAL_USDT: 0,
  SIGNAL_ALLOCATOR_ENABLED: false,
} as unknown as AppConfig;

const fill = (orderId: string, qty: number, price: number, feeUsdt = 0) => ({
  id: `fill-${orderId}`,
  type: 'execution.order.filled',
  ts: 0,
  source: 'test',
  symbol: 'SOLUSDT',
  payload: { orderId, symbol: 'SOLUSDT', side: 'LONG', quantity: qty, price, feeUsdt },
});

describe('RiskEngine entryPrice + costBasis (M-19)', () => {
  it('first fill: entryPrice == price, costBasis == notional + feeUsdt', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('o-1', 2, 100, 0.1));
    const pos = engine.getExposure().positions.get('SOLUSDT')!;
    expect(pos.entryPrice).toBe(100);
    expect(pos.notional).toBe(200);
    expect((pos as any).costBasis).toBeCloseTo(200.1, 6);
  });

  it('pyramid: entryPrice is the VWAP across fills, costBasis sums fees', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('o-1', 2, 100, 0.1));
    bus.publish(fill('o-2', 3, 110, 0.2));
    const pos = engine.getExposure().positions.get('SOLUSDT')!;
    // VWAP = (2*100 + 3*110) / 5 = 530 / 5 = 106
    expect(pos.entryPrice).toBeCloseTo(106, 6);
    expect(pos.quantity).toBe(5);
    expect(pos.notional).toBe(530);
    expect((pos as any).costBasis).toBeCloseTo(530.3, 6);
  });

  it('seedPositions initialises costBasis to notional (no fee data available)', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    engine.seedPositions([{ symbol: 'SOLUSDT', side: 'LONG', quantity: 1, entryPrice: 100 }]);
    const pos = engine.getExposure().positions.get('SOLUSDT')!;
    expect(pos.notional).toBe(100);
    expect((pos as any).costBasis).toBe(100);
  });

  it('reduce-only fills do not mutate costBasis (handled by close path)', () => {
    const bus = new EventBus();
    const engine = new RiskEngine(cfg, bus);
    bus.publish(fill('o-open', 2, 100, 0.1));
    bus.publish({
      id: 'fill-reduce',
      type: 'execution.order.filled',
      ts: 0, source: 'test', symbol: 'SOLUSDT',
      payload: { orderId: 'o-reduce', symbol: 'SOLUSDT', side: 'LONG', quantity: 1, price: 105, feeUsdt: 0.05, reason: 'PARTIAL_TP' },
    });
    const pos = engine.getExposure().positions.get('SOLUSDT')!;
    expect((pos as any).costBasis).toBeCloseTo(200.1, 6);
  });
});
