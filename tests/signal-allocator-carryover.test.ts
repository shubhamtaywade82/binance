import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { SignalAllocator } from '../src/core/execution/signal-allocator';
import type { RiskEngine } from '../src/core/risk/risk-engine';
import type { AppConfig } from '../src/config';

const cfg = {
  SEYKOTA_ADX_THRESHOLD: 20,
  SEYKOTA_MIN_ATR_PCT: 0.003,
  MAX_OPEN_SYMBOLS: 2,
} as unknown as AppConfig;

const candidate = (symbol: string, score: { adx: number; atrPct: number; closeTime: number }) => ({
  id: `req-${symbol}-${Math.random()}`,
  type: 'execution.order.requested',
  ts: Date.now(),
  source: 'test',
  symbol,
  payload: {
    symbol,
    side: 'LONG' as const,
    quantity: 1,
    price: 100,
    type: 'MARKET' as const,
    score,
  },
});

const stubRisk = (openSymbols: string[]): RiskEngine => ({
  getExposure: () => ({
    total: openSymbols.length * 100,
    symbols: openSymbols.length,
    positions: new Map(openSymbols.map((s) => [s, { side: 'LONG', notional: 100, costBasis: 100, quantity: 1, entryPrice: 100 }])),
  }),
} as unknown as RiskEngine);

describe('SignalAllocator carryover queue (M-18)', () => {
  it('forwards top-N within the slot budget and PARKS losers as carryover', async () => {
    const bus = new EventBus();
    const allocator = new SignalAllocator(cfg, bus, stubRisk([]), {
      flushDelayMs: 5,
      carryoverCapacity: 5,
    });
    const forwarded: any[] = [];
    const rejected: any[] = [];
    bus.subscribe('execution.order.requested.allocated', (e) => forwarded.push(e));
    bus.subscribe('execution.order.rejected', (e) => rejected.push(e));

    // 4 candidates competing for 2 slots, decreasing scores.
    bus.publish(candidate('A', { adx: 50, atrPct: 0.02, closeTime: 1000 }));
    bus.publish(candidate('B', { adx: 45, atrPct: 0.018, closeTime: 1000 }));
    bus.publish(candidate('C', { adx: 40, atrPct: 0.015, closeTime: 1000 }));
    bus.publish(candidate('D', { adx: 35, atrPct: 0.012, closeTime: 1000 }));
    await new Promise((r) => setTimeout(r, 30));

    expect(forwarded).toHaveLength(2);
    expect(forwarded.map((e) => e.symbol)).toEqual(['A', 'B']);
    expect(rejected).toHaveLength(0); // C/D went to carryover, not rejection
    expect(allocator.carryoverDepth()).toBe(2);
  });

  it('runners-up CLAIM newly opened slots on the next flush bar', async () => {
    const bus = new EventBus();
    // First flush: no open positions, slots=2.
    let openSymbols: string[] = [];
    const risk = {
      getExposure: () => ({
        total: openSymbols.length * 100,
        symbols: openSymbols.length,
        positions: new Map(openSymbols.map((s) => [s, { side: 'LONG', notional: 100, costBasis: 100, quantity: 1, entryPrice: 100 }])),
      }),
    } as unknown as RiskEngine;
    new SignalAllocator(cfg, bus, risk, { flushDelayMs: 5, carryoverCapacity: 5 });
    const forwarded: any[] = [];
    bus.subscribe('execution.order.requested.allocated', (e) => forwarded.push(e));

    // Bar 1: A and B win slots. C is parked.
    bus.publish(candidate('A', { adx: 50, atrPct: 0.02, closeTime: 1000 }));
    bus.publish(candidate('B', { adx: 45, atrPct: 0.018, closeTime: 1000 }));
    bus.publish(candidate('C', { adx: 40, atrPct: 0.015, closeTime: 1000 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(forwarded.map((e) => e.symbol)).toEqual(['A', 'B']);

    // Bar 2: A and B are both still open; one slot opens up.
    openSymbols = ['A']; // B was closed externally
    bus.publish(candidate('D', { adx: 25, atrPct: 0.004, closeTime: 2000 })); // low score
    await new Promise((r) => setTimeout(r, 30));

    // C (carryover, higher score) and D (fresh) compete for the 1 free slot.
    // C should win because it had a higher score.
    const newForwards = forwarded.slice(2);
    expect(newForwards).toHaveLength(1);
    expect(newForwards[0].symbol).toBe('C');
  });

  it('carryover capacity cap rejects excess runners-up', async () => {
    const bus = new EventBus();
    const allocator = new SignalAllocator(cfg, bus, stubRisk([]), {
      flushDelayMs: 5,
      carryoverCapacity: 1,
    });
    const rejected: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejected.push(e));
    bus.publish(candidate('A', { adx: 50, atrPct: 0.02, closeTime: 1000 }));
    bus.publish(candidate('B', { adx: 45, atrPct: 0.018, closeTime: 1000 }));
    bus.publish(candidate('C', { adx: 40, atrPct: 0.015, closeTime: 1000 }));
    bus.publish(candidate('D', { adx: 35, atrPct: 0.012, closeTime: 1000 }));
    await new Promise((r) => setTimeout(r, 30));
    // 2 forwarded, 1 carryover, 1 explicit rejection.
    expect(allocator.carryoverDepth()).toBe(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.reason).toBe('WORSE_THAN_TOP_CANDIDATES');
  });

  it('expires carryover entries past carryoverMaxAgeMs', async () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const allocator = new SignalAllocator(cfg, bus, stubRisk([]), {
        flushDelayMs: 5,
        carryoverCapacity: 10,
        carryoverMaxAgeMs: 1000,
      });

      bus.publish(candidate('A', { adx: 50, atrPct: 0.02, closeTime: 1000 }));
      bus.publish(candidate('B', { adx: 45, atrPct: 0.018, closeTime: 1000 }));
      bus.publish(candidate('C', { adx: 40, atrPct: 0.015, closeTime: 1000 }));
      await vi.advanceTimersByTimeAsync(10);
      expect(allocator.carryoverDepth()).toBe(1);

      // Advance past carryoverMaxAgeMs.
      await vi.advanceTimersByTimeAsync(2000);

      // Next bar — no fresh candidates. Carryover should be drained on flush.
      bus.publish(candidate('Z', { adx: 25, atrPct: 0.004, closeTime: 3000 }));
      await vi.advanceTimersByTimeAsync(10);

      // C expired and was not re-considered.
      expect(allocator.carryoverDepth()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
