import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { TrailingStopManager } from '../src/core/execution/trailing-stop-manager';
import type { DomainEvent } from '@coindcx/contracts';

describe('TrailingStopManager', () => {
  let bus: EventBus;
  let captured: DomainEvent[];

  beforeEach(() => {
    bus = new EventBus();
    captured = [];
    bus.subscribeAll((e) => captured.push(e));
  });

  function pubFill(symbol: string, side: 'LONG' | 'SHORT', price: number, stop: number): void {
    bus.publish({
      id: 'fill', type: 'execution.order.filled', ts: 1, source: 't', symbol,
      payload: { orderId: 'o1', symbol, side, price, quantity: 1, stopLoss: stop },
    });
  }
  function pubKline(symbol: string, close: number, high: number, low: number): void {
    bus.publish({
      id: `k-${close}`, type: 'market.kline.closed', ts: 2, source: 't', symbol,
      payload: { close, high, low, openTime: 0, closeTime: 0, open: close, volume: 1 },
    });
  }

  it('does not close while LONG price stays above ATR trail', () => {
    new TrailingStopManager(bus, { atrMult: 3, defaultAtrPct: 0.01, klineOnly: true });
    pubFill('BTCUSDT', 'LONG', 100, 97); // stop=97 → atr=1
    pubKline('BTCUSDT', 101, 101.5, 100.5); // highWater=101.5, trail=98.5 (init 97 wins)
    pubKline('BTCUSDT', 105, 105.2, 104.0); // highWater=105.2, trail=102.2 → above init 97

    const closes = captured.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(0);
  });

  it('emits close request when LONG breaches trail', () => {
    new TrailingStopManager(bus, { atrMult: 3, defaultAtrPct: 0.01, klineOnly: true });
    pubFill('BTCUSDT', 'LONG', 100, 97);
    pubKline('BTCUSDT', 110, 110, 109);   // highWater=110, trail = max(97, 110-3) = 107
    pubKline('BTCUSDT', 106, 110, 105);   // close 106 ≤ trail 107 → fire

    const closes = captured.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(1);
    expect(closes[0].payload).toMatchObject({ symbol: 'BTCUSDT', side: 'LONG', reason: 'TRAIL' });
  });

  it('emits close request when SHORT breaches trail upward', () => {
    new TrailingStopManager(bus, { atrMult: 3, defaultAtrPct: 0.01, klineOnly: true });
    pubFill('BTCUSDT', 'SHORT', 100, 103);
    pubKline('BTCUSDT', 90, 92, 90);     // lowWater=90, trail = min(103, 90+3) = 93
    pubKline('BTCUSDT', 94, 95, 90);     // close 94 ≥ trail 93 → fire

    const closes = captured.filter((e) => e.type === 'execution.position.close.requested');
    expect(closes).toHaveLength(1);
  });

  it('removes position on execution.position.closed', () => {
    const mgr = new TrailingStopManager(bus, { atrMult: 3, defaultAtrPct: 0.01, klineOnly: true });
    pubFill('BTCUSDT', 'LONG', 100, 97);
    bus.publish({
      id: 'closed', type: 'execution.position.closed', ts: 3, source: 't', symbol: 'BTCUSDT',
      payload: { symbol: 'BTCUSDT', orderId: 'o1' },
    });
    expect(mgr.getPositions().size).toBe(0);
  });
});
