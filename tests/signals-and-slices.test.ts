import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LiquidationCascadeTracker } from '../src/signals/liquidation-tracker';
import { FundingTracker } from '../src/signals/funding-tracker';
import { OiPoller } from '../src/signals/oi-poller';
import { IncomeReconciler } from '../src/signals/income-reconciler';
import type { ForceOrderEvent } from '../src/binance/ws-multiplex';
import type { BinanceRestClient } from '../src/binance/rest-client';

const mkForceOrder = (overrides: Partial<ForceOrderEvent> = {}): ForceOrderEvent => ({
  symbol: 'SOLUSDT',
  side: 'SELL',
  orderType: 'LIMIT',
  timeInForce: 'IOC',
  origQty: '100',
  price: '150',
  avgPrice: '150',
  orderStatus: 'FILLED',
  lastFilledQty: '100',
  filledAccumulatedQty: '100',
  tradeTime: Date.now(),
  ...overrides,
});

// ─── LiquidationCascadeTracker ──────────────────────────────────────────────

describe('LiquidationCascadeTracker', () => {
  it('tracks rolling forced volume', () => {
    const tracker = new LiquidationCascadeTracker(100);
    const now = Date.now();
    tracker.push(mkForceOrder({ tradeTime: now - 5000, filledAccumulatedQty: '10', avgPrice: '150' }));
    tracker.push(mkForceOrder({ tradeTime: now, filledAccumulatedQty: '20', avgPrice: '150' }));

    const vol = tracker.rollingForcedVolume(30);
    expect(vol).toBe(10 * 150 + 20 * 150);
  });

  it('excludes events outside rolling window', () => {
    const tracker = new LiquidationCascadeTracker(100);
    const now = Date.now();
    tracker.push(mkForceOrder({ tradeTime: now - 60_000, filledAccumulatedQty: '10', avgPrice: '100' }));
    tracker.push(mkForceOrder({ tradeTime: now, filledAccumulatedQty: '5', avgPrice: '100' }));

    const vol = tracker.rollingForcedVolume(30);
    expect(vol).toBe(5 * 100);
  });

  it('detects cascade active above threshold', () => {
    const tracker = new LiquidationCascadeTracker(100);
    const now = Date.now();
    tracker.push(mkForceOrder({ tradeTime: now, filledAccumulatedQty: '1000', avgPrice: '150' }));

    expect(tracker.cascadeActive(30, 100_000)).toBe(true);
    expect(tracker.cascadeActive(30, 200_000)).toBe(false);
  });

  it('calculates side bias (longs liquidated = bearish)', () => {
    const tracker = new LiquidationCascadeTracker(100);
    const now = Date.now();
    tracker.push(mkForceOrder({ tradeTime: now, side: 'SELL', filledAccumulatedQty: '100', avgPrice: '100' }));
    tracker.push(mkForceOrder({ tradeTime: now, side: 'BUY', filledAccumulatedQty: '50', avgPrice: '100' }));

    const bias = tracker.sideBias(30);
    expect(bias).toBeGreaterThan(0);
  });

  it('returns zero count/volume when empty', () => {
    const tracker = new LiquidationCascadeTracker(100);
    expect(tracker.rollingForcedVolume(30)).toBe(0);
    expect(tracker.rollingForcedCount(30)).toBe(0);
    expect(tracker.sideBias(30)).toBe(0);
  });

  it('snapshot returns volume, count, sideBias', () => {
    const tracker = new LiquidationCascadeTracker(100);
    tracker.push(mkForceOrder({ tradeTime: Date.now() }));
    const snap = tracker.snapshot(30);
    expect(snap).toHaveProperty('volume30s');
    expect(snap).toHaveProperty('count30s');
    expect(snap).toHaveProperty('sideBias30s');
    expect(snap.count30s).toBe(1);
  });
});

// ─── FundingTracker ─────────────────────────────────────────────────────────

describe('FundingTracker', () => {
  it('returns neutral when insufficient data', () => {
    const ft = new FundingTracker();
    expect(ft.snapshot().crowdedSide).toBe('NEUTRAL');
    expect(ft.snapshot().zscore).toBe(0);
  });

  it('computes z-score and detects extreme funding', () => {
    const ft = new FundingTracker(20, 2);
    for (let i = 0; i < 20; i++) ft.update(0.0001);
    ft.update(0.005);
    const snap = ft.snapshot();
    expect(snap.zscore).toBeGreaterThan(2);
    expect(snap.extremeFlag).toBe(true);
    expect(snap.crowdedSide).toBe('LONG');
  });

  it('detects crowded short on extreme negative funding', () => {
    const ft = new FundingTracker(20, 2);
    for (let i = 0; i < 20; i++) ft.update(-0.0001);
    ft.update(-0.005);
    const snap = ft.snapshot();
    expect(snap.extremeFlag).toBe(true);
    expect(snap.crowdedSide).toBe('SHORT');
  });

  it('reports neutral when no extreme', () => {
    const ft = new FundingTracker(10, 2);
    for (let i = 0; i < 10; i++) ft.update(0.0001);
    const snap = ft.snapshot();
    expect(snap.extremeFlag).toBe(false);
    expect(snap.crowdedSide).toBe('NEUTRAL');
  });
});

// ─── OiPoller ───────────────────────────────────────────────────────────────

describe('OiPoller', () => {
  const mockClient = {
    publicGet: vi.fn().mockResolvedValue({ openInterest: '500000', symbol: 'SOLUSDT', time: Date.now() }),
    signedGet: vi.fn(),
    signedPost: vi.fn(),
    signedPut: vi.fn(),
    signedDelete: vi.fn(),
  } as unknown as BinanceRestClient;

  it('returns neutral snapshot with no data', () => {
    const poller = new OiPoller(mockClient, 'SOLUSDT', 10, 60);
    const snap = poller.snapshot();
    expect(snap.oi).toBe(0);
    expect(snap.regime).toBe('neutral');
  });

  it('stops cleanly', () => {
    const poller = new OiPoller(mockClient, 'SOLUSDT', 10, 60);
    poller.start();
    poller.stop();
    poller.stop();
  });
});

// ─── IncomeReconciler ───────────────────────────────────────────────────────

describe('IncomeReconciler', () => {
  it('accumulates local PnL', () => {
    const mockClient = {
      signedGet: vi.fn().mockResolvedValue([]),
      publicGet: vi.fn(),
      signedPost: vi.fn(),
      signedPut: vi.fn(),
      signedDelete: vi.fn(),
    } as unknown as BinanceRestClient;

    const reconciler = new IncomeReconciler(mockClient, 'SOLUSDT', 300_000);
    reconciler.addLocalPnl(10);
    reconciler.addLocalPnl(-3);
    reconciler.reset();
  });

  it('detects discrepancy on reconcile', async () => {
    const onDiscrepancy = vi.fn();
    const mockClient = {
      signedGet: vi.fn().mockResolvedValue([
        { income: '5.5', symbol: 'SOLUSDT', incomeType: 'REALIZED_PNL', time: Date.now(), asset: 'USDT', info: '', tranId: 1, tradeId: '' },
      ]),
      publicGet: vi.fn(),
      signedPost: vi.fn(),
      signedPut: vi.fn(),
      signedDelete: vi.fn(),
    } as unknown as BinanceRestClient;

    const reconciler = new IncomeReconciler(mockClient, 'SOLUSDT', 300_000, onDiscrepancy, 0.01);
    reconciler.addLocalPnl(10);
    await reconciler.reconcile();
    expect(onDiscrepancy).toHaveBeenCalled();
    const result = onDiscrepancy.mock.calls[0][0];
    expect(result.exchangePnl).toBe(5.5);
    expect(result.localPnl).toBe(10);
    expect(result.discrepancy).toBeCloseTo(4.5);
  });
});
