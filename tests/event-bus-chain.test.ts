import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { RiskEngine } from '../src/core/risk/risk-engine';
import { SignalToOrderBridge } from '../src/core/execution/signal-to-order-bridge';
import { ExecutionBridge } from '../src/core/execution/execution-bridge';
import type { DomainEvent, SignalPayload } from '@coindcx/contracts';
import type { ExecutionAdapter, OrderRequest, OrderResult } from '../src/execution/types';

class StubAdapter implements ExecutionAdapter {
  name = 'paper' as const;
  public calls: OrderRequest[] = [];
  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    this.calls.push(req);
    return {
      ok: true,
      orderId: `ord-${this.calls.length}`,
      fill: { price: req.referencePrice, quantity: req.quantity, feeUsdt: 0, slippageUsdt: 0, latencyMs: 1, timestamp: Date.now() },
    };
  }
  async closePosition(): Promise<any> { return {}; }
}

function fakeCfg(overrides: Record<string, any> = {}): any {
  return {
    LEVERAGE: 5,
    CAPITAL_PER_TRADE_USDT: 100,
    TP_PRICE_PCT: 0.01,
    SL_PRICE_PCT: 0.005,
    MAX_TOTAL_EXPOSURE_USDT: 1_000_000,
    MAX_OPEN_SYMBOLS: 10,
    MAX_OPEN_POSITIONS: 10,
    MAX_NOTIONAL_USDT: 1_000_000,
    MIN_SIGNAL_CONFIDENCE: 0.5,
    ...overrides,
  };
}

describe('event-bus execution chain', () => {
  let bus: EventBus;
  let adapter: StubAdapter;
  let captured: DomainEvent[];

  beforeEach(() => {
    bus = new EventBus();
    adapter = new StubAdapter();
    captured = [];
    bus.subscribeAll((e) => captured.push(e));
  });

  it('routes strategy.signal → order.requested → order.accepted → order.submitted → order.filled', async () => {
    const cfg = fakeCfg();
    new RiskEngine(cfg, bus);
    new SignalToOrderBridge(cfg, bus, { lastPrice: () => 100 }, { cooldownMs: 0 });
    new ExecutionBridge(cfg, bus, adapter);

    const sig: SignalPayload = { strategyId: 'test', signal: 'LONG', confidence: 0.9 };
    bus.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 1, source: 'test', symbol: 'BTCUSDT', payload: sig,
    });

    await new Promise((r) => setImmediate(r));

    const types = captured.map((e) => e.type);
    expect(types).toContain('execution.order.requested');
    expect(types).toContain('execution.order.accepted');
    expect(types).toContain('execution.order.submitted');
    expect(types).toContain('execution.order.filled');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].side).toBe('LONG');
    expect(adapter.calls[0].pair).toBe('BTCUSDT');
  });

  it('honors PLACE_ORDER=false before adapter submission', async () => {
    const cfg = fakeCfg({ PLACE_ORDER: false });
    new RiskEngine(cfg, bus);
    new SignalToOrderBridge(cfg, bus, { lastPrice: () => 100 }, { cooldownMs: 0 });
    new ExecutionBridge(cfg, bus, adapter);

    bus.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 1, source: 'test', symbol: 'BTCUSDT', payload: { strategyId: 'test', signal: 'LONG', confidence: 0.9 },
    });

    await new Promise((r) => setImmediate(r));

    expect(adapter.calls).toHaveLength(0);
    const reject = captured.find((e) => e.type === 'execution.order.rejected');
    expect(reject?.payload).toMatchObject({ reason: 'PLACE_ORDER_DISABLED' });
  });

  it('rejects when order notional exceeds MAX_NOTIONAL_USDT', async () => {
    const cfg = fakeCfg({ MAX_NOTIONAL_USDT: 50 }); // 100 capital * 5 lev = 500 notional > 50
    new RiskEngine(cfg, bus);
    new SignalToOrderBridge(cfg, bus, { lastPrice: () => 100 }, { cooldownMs: 0 });
    new ExecutionBridge(cfg, bus, adapter);

    bus.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 1, source: 'test', symbol: 'BTCUSDT',
      payload: { strategyId: 't', signal: 'LONG', confidence: 0.9 },
    });
    await new Promise((r) => setImmediate(r));

    expect(captured.some((e) => e.type === 'execution.order.rejected')).toBe(true);
    expect(captured.some((e) => e.type === 'execution.order.filled')).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });

  it('drops signals below MIN_SIGNAL_CONFIDENCE', async () => {
    const cfg = fakeCfg({ MIN_SIGNAL_CONFIDENCE: 0.8 });
    new RiskEngine(cfg, bus);
    new SignalToOrderBridge(cfg, bus, { lastPrice: () => 100 }, { cooldownMs: 0 });
    new ExecutionBridge(cfg, bus, adapter);

    bus.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 1, source: 'test', symbol: 'BTCUSDT',
      payload: { strategyId: 't', signal: 'LONG', confidence: 0.5 },
    });
    await new Promise((r) => setImmediate(r));

    expect(captured.some((e) => e.type === 'execution.order.requested')).toBe(false);
    expect(adapter.calls).toHaveLength(0);
  });

  it('blocks opposite-side open on already-open symbol', async () => {
    const cfg = fakeCfg();
    new RiskEngine(cfg, bus);
    new SignalToOrderBridge(cfg, bus, { lastPrice: () => 100 }, { cooldownMs: 0 });
    new ExecutionBridge(cfg, bus, adapter);

    bus.publish({
      id: 'sig-1', type: 'strategy.signal', ts: 1, source: 't', symbol: 'BTCUSDT',
      payload: { strategyId: 't', signal: 'LONG', confidence: 0.9 },
    });
    await new Promise((r) => setImmediate(r));
    bus.publish({
      id: 'sig-2', type: 'strategy.signal', ts: 2, source: 't', symbol: 'BTCUSDT',
      payload: { strategyId: 't', signal: 'SHORT', confidence: 0.9 },
    });
    await new Promise((r) => setImmediate(r));

    expect(adapter.calls).toHaveLength(1);
    const rejects = captured.filter((e) => e.type === 'execution.order.rejected');
    expect(rejects.some((e: any) => e.payload.reason === 'OPPOSITE_SIDE_OPEN_POSITION')).toBe(true);
  });

  it('forwards strategy risk metadata into adapter requests and fill events', async () => {
    const cfg = fakeCfg({ LEVERAGE: 5 });
    new RiskEngine(cfg, bus);
    new ExecutionBridge(cfg, bus, adapter);

    bus.publish({
      id: 'req-1',
      type: 'execution.order.requested',
      ts: 1,
      source: 'test',
      symbol: 'ETHUSDT',
      payload: {
        symbol: 'ETHUSDT',
        side: 'SHORT',
        quantity: 2,
        type: 'MARKET',
        price: 100,
        stopLoss: 103,
        takeProfit: 95,
        strategyId: 'adaptive-test',
        leverageHint: 3,
        atrAtEntry: 1,
      } as any,
    });
    await new Promise((r) => setImmediate(r));

    expect(adapter.calls[0]).toMatchObject({
      leverage: 3,
      stopLoss: 103,
      takeProfit: 95,
    });
    const fill = captured.find((e) => e.type === 'execution.order.filled');
    expect(fill?.payload).toMatchObject({
      leverage: 3,
      stopLoss: 103,
      takeProfit: 95,
      atrAtEntry: 1,
    });
  });
});
