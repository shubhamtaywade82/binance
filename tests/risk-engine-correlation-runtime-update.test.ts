import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { RiskEngine } from '../src/core/risk/risk-engine';
import type { AppConfig } from '../src/config';

const cfgWithCorr = (pairsJson?: string): AppConfig => ({
  MAX_TOTAL_EXPOSURE_USDT: 1_000_000,
  MAX_OPEN_SYMBOLS: 5,
  MAX_OPEN_POSITIONS: 5,
  MAX_NOTIONAL_USDT: 1_000_000,
  SIGNAL_ALLOCATOR_ENABLED: false,
  CORRELATION_PAIRS_JSON: pairsJson ?? '',
  CORRELATION_THRESHOLD: 0.7,
} as unknown as AppConfig);

const fill = (symbol: string) => ({
  id: `fill-${symbol}`,
  type: 'execution.order.filled',
  ts: 0, source: 'test', symbol,
  payload: { orderId: `o-${symbol}`, symbol, side: 'LONG', quantity: 1, price: 100 },
});

const request = (symbol: string) => ({
  id: `req-${symbol}-${Math.random()}`,
  type: 'execution.order.requested',
  ts: 0, source: 'test', symbol,
  payload: { symbol, side: 'LONG', quantity: 1, price: 100, type: 'MARKET' },
});

const correlationUpdate = (pairs: Array<{ symbolA: string; symbolB: string; correlation: number }>) => ({
  id: `corr-${Math.random()}`,
  type: 'risk.correlations.update',
  ts: 0, source: 'test',
  payload: { pairs },
});

describe('RiskEngine runtime correlation updates (M-3)', () => {
  it('starts with no correlation guard when CORRELATION_PAIRS_JSON is empty', () => {
    const bus = new EventBus();
    new RiskEngine(cfgWithCorr(''), bus);

    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.publish(fill('BTCUSDT'));
    bus.publish(request('ETHUSDT'));
    // No correlation guard → no rejection on correlation grounds.
    expect(rejections.filter((e) => String(e.payload.reason).startsWith('CORRELATION_'))).toHaveLength(0);
  });

  it('publishing risk.correlations.update creates a guard at runtime', () => {
    const bus = new EventBus();
    new RiskEngine(cfgWithCorr(''), bus);

    // Push correlations after engine is up.
    bus.publish(correlationUpdate([
      { symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.85 },
    ]));

    bus.publish(fill('BTCUSDT'));
    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.publish(request('ETHUSDT'));
    expect(rejections).toHaveLength(1);
    expect(String(rejections[0].payload.reason)).toMatch(/^CORRELATION_BLOCKED/);
  });

  it('a second update REPLACES the matrix (old pair no longer blocks)', () => {
    const bus = new EventBus();
    new RiskEngine(
      cfgWithCorr(JSON.stringify([{ symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.9 }])),
      bus,
    );
    // Replace: drop the BTC↔ETH pair, install BTC↔SOL instead.
    bus.publish(correlationUpdate([
      { symbolA: 'BTCUSDT', symbolB: 'SOLUSDT', correlation: 0.9 },
    ]));

    bus.publish(fill('BTCUSDT'));
    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.publish(request('ETHUSDT')); // no longer correlated with BTC
    expect(rejections).toHaveLength(0);

    bus.publish(request('SOLUSDT')); // newly correlated → blocked
    expect(rejections).toHaveLength(1);
  });

  it('empty pairs array is ignored (no-op) — does not wipe the existing guard', () => {
    const bus = new EventBus();
    new RiskEngine(
      cfgWithCorr(JSON.stringify([{ symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.9 }])),
      bus,
    );
    bus.publish(correlationUpdate([])); // no-op
    bus.publish(fill('BTCUSDT'));
    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.publish(request('ETHUSDT'));
    expect(rejections).toHaveLength(1); // existing pair still in force
  });

  it('threshold override propagates to the new guard', () => {
    const bus = new EventBus();
    new RiskEngine(cfgWithCorr(''), bus);
    bus.publish({
      id: 'corr-low',
      type: 'risk.correlations.update',
      ts: 0, source: 'test',
      payload: {
        pairs: [{ symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.5 }],
        threshold: 0.4, // below the default 0.7
      },
    });
    bus.publish(fill('BTCUSDT'));
    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.publish(request('ETHUSDT'));
    expect(rejections).toHaveLength(1);
  });
});
