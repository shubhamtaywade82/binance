import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { SignalToOrderBridge } from '../src/core/execution/signal-to-order-bridge';
import type { AppConfig } from '../src/config';

const cfg = {
  MIN_SIGNAL_CONFIDENCE: 0.5,
  CAPITAL_PER_TRADE_USDT: 100,
  LEVERAGE: 5,
  TP_PRICE_PCT: 0.015,
  SL_PRICE_PCT: 0.01,
} as unknown as AppConfig;

const provider = { lastPrice: (_s: string) => 100 };

const signal = (symbol: string, side: 'LONG' | 'SHORT', strategyId?: string) => ({
  id: `sig-${symbol}-${side}-${Math.random()}`,
  type: 'strategy.signal',
  ts: Date.now(),
  source: 'test',
  symbol,
  payload: { symbol, signal: side, confidence: 0.8, strategyId },
});

describe('SignalToOrderBridge (symbol, side, strategyId) cooldown (H-4)', () => {
  it('blocks a duplicate same-key signal inside the cooldown window', async () => {
    const bus = new EventBus();
    new SignalToOrderBridge(cfg, bus, provider, { cooldownMs: 60_000 });
    const orders: any[] = [];
    bus.subscribe('execution.order.requested', (e) => orders.push(e));
    bus.publish(signal('SOLUSDT', 'LONG', 'sma'));
    bus.publish(signal('SOLUSDT', 'LONG', 'sma'));
    expect(orders).toHaveLength(1);
  });

  it('allows an opposite-side signal on the same symbol (different cooldown bucket)', () => {
    const bus = new EventBus();
    new SignalToOrderBridge(cfg, bus, provider, { cooldownMs: 60_000 });
    const orders: any[] = [];
    bus.subscribe('execution.order.requested', (e) => orders.push(e));
    bus.publish(signal('SOLUSDT', 'LONG', 'sma'));
    bus.publish(signal('SOLUSDT', 'SHORT', 'sma')); // different side
    expect(orders).toHaveLength(2);
  });

  it('allows two different strategies on the same symbol+side', () => {
    const bus = new EventBus();
    new SignalToOrderBridge(cfg, bus, provider, { cooldownMs: 60_000 });
    const orders: any[] = [];
    bus.subscribe('execution.order.requested', (e) => orders.push(e));
    bus.publish(signal('SOLUSDT', 'LONG', 'smc'));
    bus.publish(signal('SOLUSDT', 'LONG', 'seykota')); // different strategyId
    expect(orders).toHaveLength(2);
  });

  it('cooldown still applies for the same (symbol, side, strategyId) tuple', () => {
    const bus = new EventBus();
    new SignalToOrderBridge(cfg, bus, provider, { cooldownMs: 60_000 });
    const orders: any[] = [];
    bus.subscribe('execution.order.requested', (e) => orders.push(e));
    bus.publish(signal('SOLUSDT', 'LONG', 'smc'));
    bus.publish(signal('SOLUSDT', 'LONG', 'smc')); // same tuple → suppressed
    bus.publish(signal('SOLUSDT', 'SHORT', 'smc')); // different side
    bus.publish(signal('ETHUSDT', 'LONG', 'smc')); // different symbol
    expect(orders).toHaveLength(3);
  });
});
