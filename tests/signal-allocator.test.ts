import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { SignalAllocator } from '../src/core/execution/signal-allocator';
import { RiskEngine } from '../src/core/risk/risk-engine';
import type { DomainEvent, OrderRequestedPayload } from '@coindcx/contracts';

function cfg(overrides: Record<string, any> = {}): any {
  return {
    SEYKOTA_ADX_THRESHOLD: 20,
    SEYKOTA_MIN_ATR_PCT: 0.003,
    MAX_TOTAL_EXPOSURE_USDT: 1_000_000,
    MAX_OPEN_SYMBOLS: 2,
    MAX_OPEN_POSITIONS: 10,
    MAX_NOTIONAL_USDT: 1_000_000,
    SIGNAL_ALLOCATOR_ENABLED: true,
    LEVERAGE: 5,
    ...overrides,
  };
}

function mkRequest(symbol: string, adx: number, atrPct: number, closeTime: number): DomainEvent<OrderRequestedPayload> {
  return {
    id: `req-${symbol}-${closeTime}`,
    type: 'execution.order.requested',
    ts: 1,
    source: 'actor',
    symbol,
    payload: {
      symbol,
      side: 'LONG',
      quantity: 1,
      type: 'MARKET',
      price: 100,
      strategyId: 'test',
      score: { adx, atrPct, closeTime },
    },
  };
}

describe('SignalAllocator', () => {
  let bus: EventBus;
  let captured: DomainEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    captured = [];
    bus.subscribeAll((e) => captured.push(e));
  });

  it('picks top N by ADX×ATR score; losers go to carryover queue (M-18)', () => {
    const c = cfg({ MAX_OPEN_SYMBOLS: 2 });
    const risk = new RiskEngine(c, bus);
    // carryoverCapacity=0 reproduces the pre-M-18 reject-losers behaviour
    // for this regression test.
    new SignalAllocator(c, bus, risk, { flushDelayMs: 100, carryoverCapacity: 0 });

    // Three candidates in the same close-window bar
    bus.publish(mkRequest('BTCUSDT', 35, 0.010, 1000)); // score = 1.5 × 3.33 = 5.0
    bus.publish(mkRequest('ETHUSDT', 28, 0.006, 1000)); // score = 0.8 × 2.0 = 1.6
    bus.publish(mkRequest('XRPUSDT', 22, 0.004, 1000)); // score = 0.2 × 1.33 = 0.27

    vi.advanceTimersByTime(150);

    const allocated = captured.filter((e) => e.type === 'execution.order.requested.allocated');
    const rejected = captured.filter((e) => e.type === 'execution.order.rejected');
    const accepted = captured.filter((e) => e.type === 'execution.order.accepted');

    expect(allocated).toHaveLength(2);
    expect(allocated.map((e) => e.payload.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.requested.symbol).toBe('XRPUSDT');
    expect((rejected[0].payload as any).reason).toBe('WORSE_THAN_TOP_CANDIDATES');
    expect(accepted).toHaveLength(2); // RiskEngine accepted both top picks
  });

  it('passes through unscored signals immediately', () => {
    const c = cfg();
    const risk = new RiskEngine(c, bus);
    new SignalAllocator(c, bus, risk, { flushDelayMs: 100 });

    bus.publish({
      id: 'r1', type: 'execution.order.requested', ts: 1, source: 'x', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', side: 'LONG', quantity: 1, type: 'MARKET', price: 100, strategyId: 'legacy' },
    });

    // No buffering — forwarded synchronously
    expect(captured.some((e) => e.type === 'execution.order.requested.allocated')).toBe(true);
  });
});

describe('CorrelationGuard in RiskEngine', () => {
  it('blocks same-direction open on correlated symbol', () => {
    const bus = new EventBus();
    const captured: DomainEvent[] = [];
    bus.subscribeAll((e) => captured.push(e));

    const c = cfg({
      SIGNAL_ALLOCATOR_ENABLED: false,
      MAX_OPEN_SYMBOLS: 5,
      CORRELATION_PAIRS_JSON: JSON.stringify([
        { symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.85 },
      ]),
      CORRELATION_THRESHOLD: 0.7,
    });
    new RiskEngine(c, bus);

    bus.publish({
      id: 'r1', type: 'execution.order.requested', ts: 1, source: 'x', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', side: 'LONG', quantity: 1, type: 'MARKET', price: 100, strategyId: 't' },
    });
    // Mark BTC as open via filled
    bus.publish({
      id: 'f1', type: 'execution.order.filled', ts: 2, source: 'x', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', side: 'LONG', quantity: 1, price: 100, orderId: 'o1' },
    });
    bus.publish({
      id: 'r2', type: 'execution.order.requested', ts: 3, source: 'x', symbol: 'ETHUSDT',
      payload: { symbol: 'ETHUSDT', side: 'LONG', quantity: 1, type: 'MARKET', price: 50, strategyId: 't' },
    });

    const rejects = captured.filter((e) => e.type === 'execution.order.rejected');
    expect(rejects.some((e: any) => String(e.payload.reason).startsWith('CORRELATION_BLOCKED'))).toBe(true);
  });
});
