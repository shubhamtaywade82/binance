import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { CoinDcxUserDataWs } from '../src/coindcx/user-data-ws';
import type { AppLogger } from '../src/logging/app-logger';

const silentLog: AppLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as AppLogger;

const makeWs = (bus: EventBus): CoinDcxUserDataWs =>
  new CoinDcxUserDataWs({
    apiKey: 'k',
    apiSecret: 's',
    log: silentLog,
    eventBus: bus,
  });

describe('CoinDcxUserDataWs canonicalises symbols at the bus boundary (C-6)', () => {
  it('publishes execution.order.filled with a canonical symbol on position open', async () => {
    const bus = new EventBus();
    const ws = makeWs(bus);
    const seen: any[] = [];
    bus.subscribe('execution.order.filled', (e) => seen.push(e));

    // Call the private handler the same way socket.io would on a real event.
    (ws as any).onPosition({
      pair: 'B-SOL_USDT',
      side: 'buy',
      position_id: 'pos-1',
      active_pos: 1.5,
      avg_price: 100,
      leverage: 5,
      user_margin: 30,
      liquidation_price: 90,
      created_at: 1700000000000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].symbol).toBe('SOLUSDT');
    expect(seen[0].payload.symbol).toBe('SOLUSDT');
  });

  it('publishes execution.position.closed with a canonical symbol when active_pos=0', async () => {
    const bus = new EventBus();
    const ws = makeWs(bus);
    const seen: any[] = [];
    bus.subscribe('execution.position.closed', (e) => seen.push(e));

    (ws as any).onPosition({
      pair: 'B-ETH_USDT',
      side: 'sell',
      position_id: 'pos-2',
      active_pos: 0,
      avg_close_price: 3100,
      pnl: -5,
      fees: 0.5,
      total_quantity: 0.1,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].symbol).toBe('ETHUSDT');
    expect(seen[0].payload.symbol).toBe('ETHUSDT');
  });

  it('publishes execution.order.* with a canonical symbol for onOrder', async () => {
    const bus = new EventBus();
    const ws = makeWs(bus);
    const seen: any[] = [];
    bus.subscribe('execution.order.filled', (e) => seen.push(e));

    (ws as any).onOrder({
      pair: 'b-btc_usdt',
      id: 'ord-1',
      status: 'filled',
      side: 'buy',
      total_quantity: 0.05,
      avg_price: 50000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].symbol).toBe('BTCUSDT');
    expect(seen[0].payload.symbol).toBe('BTCUSDT');
  });

  it('publishes execution.order.fill with a canonical symbol for onTrade', async () => {
    const bus = new EventBus();
    const ws = makeWs(bus);
    const seen: any[] = [];
    bus.subscribe('execution.order.fill', (e) => seen.push(e));

    (ws as any).onTrade({ pair: 'B-XRP_USDT', id: 'fill-1', pnl: 0.5 });

    expect(seen).toHaveLength(1);
    expect(seen[0].symbol).toBe('XRPUSDT');
  });

  it('drops position events with no resolvable symbol (empty pair)', async () => {
    const bus = new EventBus();
    const ws = makeWs(bus);
    const seen: any[] = [];
    bus.subscribe('execution.order.filled', (e) => seen.push(e));
    bus.subscribe('execution.position.closed', (e) => seen.push(e));

    (ws as any).onPosition({ pair: '', side: 'buy', position_id: 'pos-x', active_pos: 1 });
    (ws as any).onPosition({ side: 'buy', position_id: 'pos-y', active_pos: 1 });

    expect(seen).toHaveLength(0);
  });

  it('H-3: subsequent position_updates with non-increasing active_pos do NOT republish fills', () => {
    const bus = new EventBus();
    const ws = makeWs(bus);
    const seen: any[] = [];
    bus.subscribe('execution.order.filled', (e) => seen.push(e));

    // First update: 0 → 1 (open). Should publish.
    (ws as any).onPosition({ pair: 'B-SOL_USDT', side: 'buy', position_id: 'pos-1', active_pos: 1, avg_price: 100 });
    expect(seen).toHaveLength(1);
    expect(seen[0].payload.quantity).toBe(1);

    // Mark-move update: active_pos still 1, different avg_price. Must NOT publish.
    (ws as any).onPosition({ pair: 'B-SOL_USDT', side: 'buy', position_id: 'pos-1', active_pos: 1, avg_price: 102 });
    expect(seen).toHaveLength(1);

    // Pyramid add: active_pos 1 → 2. Must publish delta of 1.
    (ws as any).onPosition({ pair: 'B-SOL_USDT', side: 'buy', position_id: 'pos-1', active_pos: 2, avg_price: 101 });
    expect(seen).toHaveLength(2);
    expect(seen[1].payload.quantity).toBe(1); // delta, not absolute

    // Partial close: active_pos 2 → 1.5. Must NOT publish a fill.
    (ws as any).onPosition({ pair: 'B-SOL_USDT', side: 'buy', position_id: 'pos-1', active_pos: 1.5, avg_price: 101 });
    expect(seen).toHaveLength(2);
  });
});
