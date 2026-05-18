import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { SignalReversalExitManager } from '../src/core/execution/signal-reversal-exit-manager';
import type { DomainEvent } from '@coindcx/contracts';

function bus() {
  const b = new EventBus();
  const seen: DomainEvent[] = [];
  b.subscribeAll((e) => seen.push(e));
  return { b, seen };
}

describe('SignalReversalExitManager', () => {
  it('closes LONG position when a confident SHORT signal arrives', () => {
    const { b, seen } = bus();
    new SignalReversalExitManager(b, { minConfidence: 0.5 });

    // 1. Open a LONG position
    b.publish({
      id: 'fill-1', type: 'execution.order.filled', ts: 1, source: 't', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', side: 'LONG', price: 100, quantity: 1, orderId: 'o-1' },
    });

    // 2. Receive a SHORT signal with high confidence
    b.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 2, source: 't', symbol: 'BTCUSDT',
      payload: { signal: 'SHORT', confidence: 0.8, strategyId: 'test' },
    });

    const closes = seen.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(1);
    expect((closes[0].payload as any).reason).toBe('SIGNAL_REVERSAL');
  });

  it('does not close LONG position when a weak SHORT signal arrives', () => {
    const { b, seen } = bus();
    new SignalReversalExitManager(b, { minConfidence: 0.7 });

    b.publish({
      id: 'fill-1', type: 'execution.order.filled', ts: 1, source: 't', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', side: 'LONG', price: 100, quantity: 1, orderId: 'o-1' },
    });

    // Confidence 0.6 is below threshold 0.7
    b.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 2, source: 't', symbol: 'BTCUSDT',
      payload: { signal: 'SHORT', confidence: 0.6, strategyId: 'test' },
    });

    expect(seen.filter((e) => e.type === 'execution.position.close.requested')).toHaveLength(0);
  });

  it('does not close when signal matches current side', () => {
    const { b, seen } = bus();
    new SignalReversalExitManager(b, { minConfidence: 0.5 });

    b.publish({
      id: 'fill-1', type: 'execution.order.filled', ts: 1, source: 't', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', side: 'LONG', price: 100, quantity: 1, orderId: 'o-1' },
    });

    // Another LONG signal - ignore
    b.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 2, source: 't', symbol: 'BTCUSDT',
      payload: { signal: 'LONG', confidence: 0.9, strategyId: 'test' },
    });

    expect(seen.filter((e) => e.type === 'execution.position.close.requested')).toHaveLength(0);
  });

  it('stops tracking after position is closed via other means', () => {
    const { b, seen } = bus();
    new SignalReversalExitManager(b, { minConfidence: 0.5 });

    b.publish({
      id: 'fill-1', type: 'execution.order.filled', ts: 1, source: 't', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', side: 'LONG', price: 100, quantity: 1, orderId: 'o-1' },
    });

    // Close via SL/Trail
    b.publish({
      id: 'close-1', type: 'execution.position.closed', ts: 2, source: 't', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', orderId: 'o-1', reason: 'SL' },
    });

    // Now a SHORT signal arrives - should be ignored as no position is open
    b.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 3, source: 't', symbol: 'BTCUSDT',
      payload: { signal: 'SHORT', confidence: 0.8, strategyId: 'test' },
    });

    expect(seen.filter((e) => e.type === 'execution.position.close.requested')).toHaveLength(0);
  });
});
