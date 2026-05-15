import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TradingMetricsTracker } from '../src/metrics/trading-metrics';
import { ModelMetricsTracker } from '../src/metrics/model-metrics';
import { SystemMetricsTracker } from '../src/metrics/system-metrics';
import { MetricsCollector } from '../src/metrics/metrics-collector';

describe('TradingMetricsTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns zeroed snapshot with no data', () => {
    const t = new TradingMetricsTracker();
    const s = t.snapshot();
    expect(s.realizedPnl).toBe(0);
    expect(s.totalTrades).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.profitFactor).toBe(0);
    expect(s.sharpe7d).toBe(0);
    expect(s.sharpe30d).toBe(0);
  });

  it('accumulates realized PnL from trades', () => {
    const t = new TradingMetricsTracker();
    t.recordTrade(100);
    t.recordTrade(-30);
    t.recordTrade(50);

    const s = t.snapshot();
    expect(s.realizedPnl).toBe(120);
    expect(s.totalTrades).toBe(3);
    expect(s.winningTrades).toBe(2);
    expect(s.losingTrades).toBe(1);
  });

  it('computes win rate correctly', () => {
    const t = new TradingMetricsTracker();
    t.recordTrade(10);
    t.recordTrade(-5);
    t.recordTrade(20);
    t.recordTrade(-3);

    expect(t.snapshot().winRate).toBeCloseTo(0.5);
  });

  it('computes avgWin and avgLoss', () => {
    const t = new TradingMetricsTracker();
    t.recordTrade(100);
    t.recordTrade(200);
    t.recordTrade(-50);
    t.recordTrade(-150);

    const s = t.snapshot();
    expect(s.avgWin).toBe(150);
    expect(s.avgLoss).toBe(100);
  });

  it('computes profit factor as avgWin / avgLoss', () => {
    const t = new TradingMetricsTracker();
    t.recordTrade(300);
    t.recordTrade(-100);

    expect(t.snapshot().profitFactor).toBe(3);
  });

  it('returns zero profit factor when no losses', () => {
    const t = new TradingMetricsTracker();
    t.recordTrade(100);

    expect(t.snapshot().profitFactor).toBe(0);
  });

  it('tracks unrealized PnL', () => {
    const t = new TradingMetricsTracker();
    t.updateUnrealizedPnl(500);
    expect(t.snapshot().unrealizedPnl).toBe(500);

    t.updateUnrealizedPnl(-200);
    expect(t.snapshot().unrealizedPnl).toBe(-200);
  });

  it('tracks drawdown from peak', () => {
    const t = new TradingMetricsTracker(1000);
    t.updateEquity(1200);
    t.updateEquity(900);

    const s = t.snapshot();
    expect(s.peakEquity).toBe(1200);
    expect(s.currentDrawdown).toBeCloseTo(-0.25);
    expect(s.maxDrawdown).toBeCloseTo(-0.25);
  });

  it('updates max drawdown correctly across multiple drops', () => {
    const t = new TradingMetricsTracker(1000);
    t.updateEquity(1100);
    t.updateEquity(1000); // dd = -9.09%
    t.updateEquity(1200);
    t.updateEquity(800);  // dd = -33.33%

    const s = t.snapshot();
    expect(s.maxDrawdown).toBeCloseTo(-1 / 3);
    expect(s.peakEquity).toBe(1200);
  });

  it('limits equity curve to 1000 points', () => {
    const t = new TradingMetricsTracker();
    for (let i = 0; i < 1050; i++) {
      vi.setSystemTime(i * 1000);
      t.updateEquity(1000 + i);
    }

    expect(t.snapshot().equityCurve).toHaveLength(1000);
  });

  it('computes Sharpe ratio from daily returns', () => {
    const t = new TradingMetricsTracker(1000);
    const returns = [0.01, 0.02, -0.005, 0.015, 0.01, -0.003, 0.012];
    for (const r of returns) t.recordDailyReturn(r);

    const s = t.snapshot();
    expect(s.sharpe7d).not.toBe(0);
    expect(Number.isFinite(s.sharpe7d)).toBe(true);
  });

  it('returns zero Sharpe with fewer than 2 daily returns', () => {
    const t = new TradingMetricsTracker();
    t.recordDailyReturn(0.01);

    expect(t.snapshot().sharpe7d).toBe(0);
    expect(t.snapshot().sharpe30d).toBe(0);
  });

  it('zero-PnL trade counts toward total but not win/loss', () => {
    const t = new TradingMetricsTracker();
    t.recordTrade(0);

    const s = t.snapshot();
    expect(s.totalTrades).toBe(1);
    expect(s.winningTrades).toBe(0);
    expect(s.losingTrades).toBe(0);
  });

  it('zero initial equity produces zero drawdown', () => {
    const t = new TradingMetricsTracker(0);
    t.updateEquity(0);

    const s = t.snapshot();
    expect(s.currentDrawdown).toBe(0);
    expect(s.maxDrawdown).toBe(0);
  });
});

describe('ModelMetricsTracker', () => {
  it('returns zeroed snapshot with no data', () => {
    const m = new ModelMetricsTracker();
    const s = m.snapshot();
    expect(s.predictionCount).toBe(0);
    expect(s.avgPUp).toBe(0);
    expect(s.liveAccuracy).toBe(0);
    expect(s.featureDriftFlags).toEqual([]);
  });

  it('computes running averages of predictions', () => {
    const m = new ModelMetricsTracker();
    m.recordPrediction(0.7, 0.2, 0.1);
    m.recordPrediction(0.3, 0.5, 0.2);

    const s = m.snapshot();
    expect(s.predictionCount).toBe(2);
    expect(s.avgPUp).toBeCloseTo(0.5);
    expect(s.avgPDown).toBeCloseTo(0.35);
    expect(s.avgPFlat).toBeCloseTo(0.15);
  });

  it('computes aboveThresholdPct', () => {
    const m = new ModelMetricsTracker(0.6);
    m.recordPrediction(0.7, 0.2, 0.1);   // above (0.7 > 0.6)
    m.recordPrediction(0.3, 0.5, 0.2);   // below (max 0.5 < 0.6)
    m.recordPrediction(0.1, 0.8, 0.1);   // above (0.8 > 0.6)
    m.recordPrediction(0.4, 0.3, 0.3);   // below (max 0.4 < 0.6)

    expect(m.snapshot().aboveThresholdPct).toBeCloseTo(0.5);
  });

  it('tracks live accuracy', () => {
    const m = new ModelMetricsTracker();
    m.recordOutcome(1, 1);   // correct
    m.recordOutcome(1, -1);  // wrong
    m.recordOutcome(-1, -1); // correct
    m.recordOutcome(-1, 0);  // wrong

    expect(m.snapshot().liveAccuracy).toBeCloseTo(0.5);
  });

  it('flags feature drift when value exceeds 3σ', () => {
    const m = new ModelMetricsTracker();
    for (let i = 0; i < 100; i++) {
      m.recordFeatureStats('rsi', 50 + (Math.random() - 0.5) * 2);
    }
    // Inject an extreme outlier
    m.recordFeatureStats('rsi', 200);

    const flags = m.snapshot().featureDriftFlags;
    expect(flags).toContain('rsi');
  });

  it('does not flag features with too few samples', () => {
    const m = new ModelMetricsTracker();
    m.recordFeatureStats('vol', 100);
    m.recordFeatureStats('vol', 999);

    expect(m.snapshot().featureDriftFlags).toEqual([]);
  });

  it('does not flag features within normal range', () => {
    const m = new ModelMetricsTracker();
    for (let i = 0; i < 50; i++) {
      m.recordFeatureStats('spread', 10 + i * 0.01);
    }

    expect(m.snapshot().featureDriftFlags).not.toContain('spread');
  });

  it('uses default threshold of 0.65', () => {
    const m = new ModelMetricsTracker();
    m.recordPrediction(0.66, 0.2, 0.14);  // above
    m.recordPrediction(0.3, 0.64, 0.06);  // below

    expect(m.snapshot().aboveThresholdPct).toBeCloseTo(0.5);
  });
});

describe('SystemMetricsTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns zeroed snapshot with no data', () => {
    vi.setSystemTime(1000);
    const sys = new SystemMetricsTracker();
    vi.setSystemTime(2000);

    const s = sys.snapshot();
    expect(s.wsMessageLag).toBe(0);
    expect(s.wsReconnects).toBe(0);
    expect(s.errorsPerMinute).toBe(0);
    expect(s.uptimeMs).toBe(1000);
  });

  it('computes rolling average WS lag', () => {
    const sys = new SystemMetricsTracker();
    sys.recordWsLag(1000, 1010);
    sys.recordWsLag(2000, 2020);
    sys.recordWsLag(3000, 3030);

    expect(sys.snapshot().wsMessageLag).toBeCloseTo(20);
  });

  it('caps lag ring buffer at 100 samples', () => {
    const sys = new SystemMetricsTracker();
    for (let i = 0; i < 100; i++) {
      sys.recordWsLag(i * 1000, i * 1000 + 10);
    }
    expect(sys.snapshot().wsMessageLag).toBeCloseTo(10);

    for (let i = 0; i < 100; i++) {
      sys.recordWsLag(i * 1000, i * 1000 + 50);
    }
    expect(sys.snapshot().wsMessageLag).toBeCloseTo(50);
  });

  it('counts reconnects in trailing 1 hour', () => {
    vi.setSystemTime(0);
    const sys = new SystemMetricsTracker();

    vi.setSystemTime(1000);
    sys.recordWsReconnect();
    vi.setSystemTime(2000);
    sys.recordWsReconnect();

    expect(sys.snapshot().wsReconnects).toBe(2);

    vi.setSystemTime(3600 * 1000 + 2001);
    expect(sys.snapshot().wsReconnects).toBe(0);
  });

  it('counts errors in trailing 1 minute', () => {
    vi.setSystemTime(0);
    const sys = new SystemMetricsTracker();

    vi.setSystemTime(1000);
    sys.recordError();
    vi.setSystemTime(2000);
    sys.recordError();
    sys.recordError();

    expect(sys.snapshot().errorsPerMinute).toBe(3);

    vi.setSystemTime(62_001);
    expect(sys.snapshot().errorsPerMinute).toBe(0);
  });

  it('tracks uptime since construction', () => {
    vi.setSystemTime(10_000);
    const sys = new SystemMetricsTracker();

    vi.setSystemTime(15_000);
    expect(sys.snapshot().uptimeMs).toBe(5000);
  });
});

describe('MetricsCollector', () => {
  it('aggregates all sub-trackers into fullSnapshot', () => {
    const mc = new MetricsCollector(1000);
    mc.trading.recordTrade(50);
    mc.model.recordPrediction(0.7, 0.2, 0.1);
    mc.system.recordWsLag(100, 110);

    const snap = mc.fullSnapshot();
    expect(snap.trading.realizedPnl).toBe(50);
    expect(snap.model.predictionCount).toBe(1);
    expect(snap.system.wsMessageLag).toBeCloseTo(10);
  });

  it('defaults initialEquity to 0', () => {
    const mc = new MetricsCollector();
    expect(mc.fullSnapshot().trading.peakEquity).toBe(0);
  });
});
