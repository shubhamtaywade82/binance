import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { StructureExitManager } from '../src/core/execution/structure-exit-manager';
import { TimeStopManager } from '../src/core/execution/time-stop-manager';
import { FundingExitManager } from '../src/core/execution/funding-exit-manager';
import type { DomainEvent } from '@coindcx/contracts';

function bus() {
  const b = new EventBus();
  const seen: DomainEvent[] = [];
  b.subscribeAll((e) => { seen.push(e); });
  return { b, seen };
}

function pubFill(b: EventBus, symbol: string, side: 'LONG' | 'SHORT', price: number, stopLoss?: number) {
  b.publish({
    id: `fill-${symbol}`, type: 'execution.order.filled', ts: 1, source: 't', symbol,
    payload: { symbol, side, price, quantity: 1, orderId: `o-${symbol}`, stopLoss },
  });
}

function pubKline(b: EventBus, symbol: string, candle: { open: number; high: number; low: number; close: number; openTime: number }) {
  b.publish({
    id: `k-${symbol}-${candle.openTime}`, type: 'market.kline.closed', ts: candle.openTime, source: 't', symbol,
    payload: { ...candle, closeTime: candle.openTime + 60000, volume: 1 },
  });
}

describe('StructureExitManager', () => {
  it('closes LONG when close breaks prior swing low', () => {
    const { b, seen } = bus();
    new StructureExitManager(b, { swingLookback: 3, bufferBars: 30 });

    // Build a downtrend then uptrend with a swing low at index 6 (price 80)
    for (let i = 0; i < 20; i++) {
      const p = i < 6 ? 100 - i * 2 : 88 + (i - 6) * 1.5;
      pubKline(b, 'BTCUSDT', { open: p - 0.2, high: p + 0.4, low: p - 0.5, close: p, openTime: i * 60000 });
    }
    pubFill(b, 'BTCUSDT', 'LONG', 110);

    // Now drop price below swing low (~88) → exit
    pubKline(b, 'BTCUSDT', { open: 90, high: 90, low: 80, close: 82, openTime: 21 * 60000 });

    const closes = seen.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes.length).toBeGreaterThanOrEqual(1);
    expect((closes[0].payload as any).reason).toBe('SMC_EXIT');
  });
});

describe('TimeStopManager', () => {
  it('closes after N bars when deep underwater (50% of stop distance)', () => {
    const { b, seen } = bus();
    new TimeStopManager(b, { barsThreshold: 3, thresholdPct: 0.5 });

    // Entry 100, Stop 90 -> Risk 10. 50% threshold is 95.
    pubFill(b, 'BTCUSDT', 'LONG', 100, 90);
    pubKline(b, 'BTCUSDT', { open: 99, high: 100, low: 98, close: 99, openTime: 1 });
    pubKline(b, 'BTCUSDT', { open: 99, high: 99, low: 97, close: 98, openTime: 2 });
    // This bar hits the N-bar threshold (3). Price is 94 which is < 95 (50% threshold).
    pubKline(b, 'BTCUSDT', { open: 98, high: 99, low: 94, close: 94, openTime: 3 });

    const closes = seen.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(1);
    expect((closes[0].payload as any).reason).toBe('TIME_STOP');
  });

  it('does NOT close after N bars if only slightly underwater (breakeven rule relaxed)', () => {
    const { b, seen } = bus();
    new TimeStopManager(b, { barsThreshold: 3, thresholdPct: 0.5 });

    // Entry 100, Stop 90 -> Risk 10. 50% threshold is 95.
    pubFill(b, 'BTCUSDT', 'LONG', 100, 90);
    pubKline(b, 'BTCUSDT', { open: 99, high: 100, low: 98, close: 99, openTime: 1 });
    pubKline(b, 'BTCUSDT', { open: 99, high: 99, low: 97, close: 98, openTime: 2 });
    // This bar hits the N-bar threshold (3). Price is 97 which is ABOVE 95.
    // Legacy logic would have closed here (since 97 < 100), but new logic holds.
    pubKline(b, 'BTCUSDT', { open: 98, high: 99, low: 97, close: 97, openTime: 3 });

    const closes = seen.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(0);
  });

  it('falls back to breakeven if no initial stop was provided', () => {
    const { b, seen } = bus();
    new TimeStopManager(b, { barsThreshold: 3, thresholdPct: 0.5 });

    pubFill(b, 'BTCUSDT', 'LONG', 100); // no stop
    pubKline(b, 'BTCUSDT', { open: 99, high: 100, low: 98, close: 99, openTime: 1 });
    pubKline(b, 'BTCUSDT', { open: 99, high: 99, low: 97, close: 98, openTime: 2 });
    pubKline(b, 'BTCUSDT', { open: 98, high: 99, low: 97, close: 97, openTime: 3 });

    const closes = seen.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(1);
    expect((closes[0].payload as any).reason).toBe('TIME_STOP');
  });

  it('does not close if winner', () => {
    const { b, seen } = bus();
    new TimeStopManager(b, { barsThreshold: 3, thresholdPct: 0.5 });

    pubFill(b, 'BTCUSDT', 'LONG', 100);
    pubKline(b, 'BTCUSDT', { open: 101, high: 102, low: 100, close: 102, openTime: 1 });
    pubKline(b, 'BTCUSDT', { open: 102, high: 103, low: 101, close: 103, openTime: 2 });
    pubKline(b, 'BTCUSDT', { open: 103, high: 104, low: 102, close: 104, openTime: 3 });

    expect(seen.filter((e) => e.type === 'execution.position.close.requested')).toHaveLength(0);
  });

  it('keeps tracking the runner after a partial TP', () => {
    const { b, seen } = bus();
    new TimeStopManager(b, { barsThreshold: 3, thresholdPct: 0.5 });

    pubFill(b, 'BTCUSDT', 'LONG', 100);
    b.publish({
      id: 'partial', type: 'execution.position.closed', ts: 2, source: 't', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', orderId: 'o-BTCUSDT', reason: 'PARTIAL_TP', quantity: 0.5 },
    });
    pubKline(b, 'BTCUSDT', { open: 99, high: 100, low: 98, close: 99, openTime: 3 });
    pubKline(b, 'BTCUSDT', { open: 99, high: 99, low: 97, close: 98, openTime: 4 });
    pubKline(b, 'BTCUSDT', { open: 98, high: 99, low: 97, close: 97, openTime: 5 });

    const closes = seen.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(1);
    expect((closes[0].payload as any).reason).toBe('TIME_STOP');
  });
});

describe('FundingExitManager', () => {
  it('closes LONG before adverse positive funding tick', () => {
    vi.useFakeTimers();
    const { b, seen } = bus();
    const fundingEngine: any = {
      getRate: () => ({ rate: 0.006, nextTime: Date.now() + 30_000 }), // 60 bps positive
    };
    new FundingExitManager(b, fundingEngine, {
      perTickThresholdBps: 50, preTickWindowSec: 60, pollMs: 1000,
    });

    pubFill(b, 'BTCUSDT', 'LONG', 100);
    vi.advanceTimersByTime(1100);

    const closes = seen.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes.length).toBeGreaterThanOrEqual(1);
    expect((closes[0].payload as any).reason).toBe('FUNDING_KICK');
    vi.useRealTimers();
  });

  it('does NOT close SHORT when funding is positive (longs pay)', () => {
    vi.useFakeTimers();
    const { b, seen } = bus();
    const fundingEngine: any = {
      getRate: () => ({ rate: 0.006, nextTime: Date.now() + 30_000 }),
    };
    new FundingExitManager(b, fundingEngine, {
      perTickThresholdBps: 50, preTickWindowSec: 60, pollMs: 1000,
    });

    pubFill(b, 'BTCUSDT', 'SHORT', 100);
    vi.advanceTimersByTime(1100);

    expect(seen.filter((e) => e.type === 'execution.position.close.requested')).toHaveLength(0);
    vi.useRealTimers();
  });
});
