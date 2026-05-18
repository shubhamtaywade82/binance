import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { SymbolActor } from '../src/core/actors/symbol-actor';

const mkEvent = (type: string, symbol: string, payload: Record<string, unknown> = {}) => ({
  id: `${type}-${symbol}-${Math.random()}`,
  type,
  ts: 0,
  source: 'test',
  symbol,
  payload,
});

describe('SymbolActor per-type subscriptions + dispose (M-4)', () => {
  it('only processes events for its own symbol', () => {
    const bus = new EventBus();
    const subSpy = vi.spyOn(bus, 'subscribe');
    const actor = new SymbolActor('SOLUSDT', bus, { executionTf: '5m' });

    // Spy on the strategies array → confirm strategy handlers fire only for SOL.
    const onKline = vi.fn(() => null);
    actor.addStrategy(() => ({
      getName: () => 'spy',
      onKline,
    } as any));

    bus.publish(mkEvent('market.kline.closed', 'ETHUSDT', { openTime: 0, close: 100, timeframe: '5m' }));
    bus.publish(mkEvent('market.kline.closed', 'SOLUSDT', { openTime: 0, close: 200, timeframe: '5m' }));
    bus.publish(mkEvent('market.kline.closed', 'BTCUSDT', { openTime: 0, close: 300, timeframe: '5m' }));

    expect(onKline).toHaveBeenCalledTimes(1);
    expect(onKline.mock.calls[0][0].close).toBe(200);

    // M-4: the actor subscribes once per event type (4 types) — not subscribeAll.
    expect(subSpy).toHaveBeenCalledTimes(4);
  });

  it('dispose() detaches all subscriptions — subsequent events are NOT processed', () => {
    const bus = new EventBus();
    const actor = new SymbolActor('SOLUSDT', bus, { executionTf: '5m' });
    const onKline = vi.fn(() => null);
    actor.addStrategy(() => ({ getName: () => 'spy', onKline } as any));

    bus.publish(mkEvent('market.kline.closed', 'SOLUSDT', { openTime: 0, close: 100, timeframe: '5m' }));
    expect(onKline).toHaveBeenCalledTimes(1);

    actor.dispose();
    bus.publish(mkEvent('market.kline.closed', 'SOLUSDT', { openTime: 60_000, close: 101, timeframe: '5m' }));
    expect(onKline).toHaveBeenCalledTimes(1); // unchanged
  });

  it('multiple actors on the same bus do not interfere', () => {
    const bus = new EventBus();
    const onSol = vi.fn(() => null);
    const onEth = vi.fn(() => null);

    const a = new SymbolActor('SOLUSDT', bus, { executionTf: '5m' });
    a.addStrategy(() => ({ getName: () => 's', onKline: onSol } as any));
    const b = new SymbolActor('ETHUSDT', bus, { executionTf: '5m' });
    b.addStrategy(() => ({ getName: () => 's', onKline: onEth } as any));

    bus.publish(mkEvent('market.kline.closed', 'SOLUSDT', { openTime: 0, close: 100, timeframe: '5m' }));
    bus.publish(mkEvent('market.kline.closed', 'ETHUSDT', { openTime: 0, close: 200, timeframe: '5m' }));

    expect(onSol).toHaveBeenCalledTimes(1);
    expect(onEth).toHaveBeenCalledTimes(1);
  });
});
