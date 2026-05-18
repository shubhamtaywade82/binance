import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { ExecutionBridge } from '../src/core/execution/execution-bridge';
import type { AppConfig } from '../src/config';
import type { ExecutionAdapter } from '../src/execution/types';

const baseCfg = (over: Partial<AppConfig> = {}): AppConfig => ({
  LEVERAGE: 5,
  PLACE_ORDER: true,
  SHADOW_MODE: false,
  LIVE_USE_WS_FOR_FILLS: false,
  ...over,
} as unknown as AppConfig);

const stubAdapter = (): { adapter: ExecutionAdapter; placeOrder: ReturnType<typeof vi.fn> } => {
  const placeOrder = vi.fn().mockResolvedValue({
    ok: true,
    orderId: 'o-1',
    fill: { price: 100, quantity: 1, feeUsdt: 0.05, slippageUsdt: 0, latencyMs: 0, timestamp: 0 },
  });
  const adapter: ExecutionAdapter = {
    name: 'paper',
    placeOrder,
    closePosition: vi.fn(),
  } as unknown as ExecutionAdapter;
  return { adapter, placeOrder };
};

const accepted = (symbol = 'SOLUSDT') => ({
  id: `acc-${Math.random()}`,
  type: 'execution.order.accepted',
  ts: 0,
  source: 'risk-engine',
  symbol,
  payload: {
    symbol,
    side: 'LONG' as const,
    quantity: 1,
    price: 100,
    type: 'MARKET' as const,
    correlationId: 'evt-1',
  },
});

describe('ExecutionBridge SHADOW_MODE enforcement (M-11)', () => {
  it('publishes execution.order.rejected with reason SHADOW_MODE and does NOT call the adapter', async () => {
    const bus = new EventBus();
    const { adapter, placeOrder } = stubAdapter();
    new ExecutionBridge(baseCfg({ SHADOW_MODE: true }), bus, adapter);

    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.publish(accepted());

    // Async handler — yield once.
    await new Promise((r) => setImmediate(r));
    expect(placeOrder).not.toHaveBeenCalled();
    expect(rejections).toHaveLength(1);
    expect(rejections[0].payload.reason).toBe('SHADOW_MODE');
  });

  it('still calls the adapter when SHADOW_MODE=false', async () => {
    const bus = new EventBus();
    const { adapter, placeOrder } = stubAdapter();
    new ExecutionBridge(baseCfg({ SHADOW_MODE: false }), bus, adapter);
    bus.publish(accepted());
    await new Promise((r) => setImmediate(r));
    expect(placeOrder).toHaveBeenCalledOnce();
  });

  it('PLACE_ORDER=false rejects before SHADOW_MODE is even checked', async () => {
    const bus = new EventBus();
    const { adapter, placeOrder } = stubAdapter();
    new ExecutionBridge(baseCfg({ PLACE_ORDER: false, SHADOW_MODE: true }), bus, adapter);

    const rejections: any[] = [];
    bus.subscribe('execution.order.rejected', (e) => rejections.push(e));
    bus.publish(accepted());
    await new Promise((r) => setImmediate(r));

    expect(placeOrder).not.toHaveBeenCalled();
    // PLACE_ORDER guard fires first — surfaces as PLACE_ORDER_DISABLED.
    expect(rejections[0].payload.reason).toBe('PLACE_ORDER_DISABLED');
  });
});
