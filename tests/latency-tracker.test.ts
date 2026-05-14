import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { LatencyTracker } from '../src/observability/latency-tracker';
import { FillQualityTracker } from '../src/observability/fill-quality';

describe('LatencyTracker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('tracks send → ack latency', () => {
    const lt = new LatencyTracker();
    vi.setSystemTime(1000);
    lt.recordSend('o1', 'BTCUSDT');

    vi.setSystemTime(1050);
    lt.recordAck('o1');

    const rec = lt.getRecord('o1');
    expect(rec).not.toBeNull();
    expect(rec!.sendLatencyMs).toBe(50);
  });

  it('tracks send → fill latency', () => {
    const lt = new LatencyTracker();
    vi.setSystemTime(2000);
    lt.recordSend('o2', 'ETHUSDT');

    vi.setSystemTime(2120);
    lt.recordFill('o2');

    const rec = lt.getRecord('o2');
    expect(rec!.fillLatencyMs).toBe(120);
  });

  it('computes percentile stats', () => {
    const lt = new LatencyTracker();
    for (let i = 0; i < 100; i++) {
      vi.setSystemTime(i * 1000);
      lt.recordSend(`o${i}`, 'BTCUSDT');
      vi.setSystemTime(i * 1000 + (i + 1));
      lt.recordAck(`o${i}`);
    }

    const stats = lt.sendLatencyStats();
    expect(stats.count).toBe(100);
    expect(stats.mean).toBeGreaterThan(0);
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p95).toBeGreaterThan(stats.p50);
    expect(stats.p99).toBeGreaterThanOrEqual(stats.p95);
  });

  it('returns empty stats when no records', () => {
    const lt = new LatencyTracker();
    const stats = lt.sendLatencyStats();
    expect(stats.count).toBe(0);
    expect(stats.mean).toBe(0);
  });

  it('returns null for unknown orderId', () => {
    const lt = new LatencyTracker();
    expect(lt.getRecord('nonexistent')).toBeNull();
  });

  it('ignores ack/fill for unknown orders', () => {
    const lt = new LatencyTracker();
    lt.recordAck('ghost');
    lt.recordFill('ghost');
    expect(lt.getRecord('ghost')).toBeNull();
  });

  it('evicts oldest records when maxRecords exceeded', () => {
    const lt = new LatencyTracker(3);
    vi.setSystemTime(100);
    lt.recordSend('a', 'BTC');
    lt.recordSend('b', 'BTC');
    lt.recordSend('c', 'BTC');
    lt.recordSend('d', 'BTC');

    expect(lt.getRecord('a')).toBeNull();
    expect(lt.getRecord('d')).not.toBeNull();
  });
});

describe('FillQualityTracker', () => {
  it('computes slippage for a BUY fill', () => {
    const fq = new FillQualityTracker();
    fq.record({
      orderId: 'o1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      refPrice: 100,
      fillPrice: 100.10,
      timestamp: Date.now(),
    });

    const report = fq.report();
    expect(report.totalFills).toBe(1);
    expect(report.meanSlippageBps).toBeCloseTo(10, 1);
  });

  it('computes negative slippage for a favorable BUY fill', () => {
    const fq = new FillQualityTracker();
    fq.record({
      orderId: 'o2',
      symbol: 'BTCUSDT',
      side: 'BUY',
      refPrice: 100,
      fillPrice: 99.90,
      timestamp: Date.now(),
    });

    const report = fq.report();
    expect(report.meanSlippageBps).toBeCloseTo(-10, 1);
  });

  it('computes slippage for a SELL fill (inverted sign)', () => {
    const fq = new FillQualityTracker();
    fq.record({
      orderId: 'o3',
      symbol: 'ETHUSDT',
      side: 'SELL',
      refPrice: 200,
      fillPrice: 199.80,
      timestamp: Date.now(),
    });

    const report = fq.report();
    expect(report.meanSlippageBps).toBeCloseTo(10, 1);
  });

  it('returns zeroed report when empty', () => {
    const fq = new FillQualityTracker();
    const report = fq.report();
    expect(report.totalFills).toBe(0);
    expect(report.meanSlippageBps).toBe(0);
    expect(report.stdSlippageBps).toBe(0);
  });

  it('computes median correctly for even count', () => {
    const fq = new FillQualityTracker();
    fq.record({ orderId: 'a', symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 100.01, timestamp: 1 });
    fq.record({ orderId: 'b', symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 100.03, timestamp: 2 });

    const report = fq.report();
    expect(report.medianSlippageBps).toBeCloseTo((1 + 3) / 2, 1);
  });

  it('evicts oldest records when maxRecords exceeded', () => {
    const fq = new FillQualityTracker(2);
    fq.record({ orderId: 'a', symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 110, timestamp: 1 });
    fq.record({ orderId: 'b', symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 100.01, timestamp: 2 });
    fq.record({ orderId: 'c', symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 100.02, timestamp: 3 });

    const recent = fq.recentRecords(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].orderId).toBe('b');
  });

  it('recentRecords returns last N records', () => {
    const fq = new FillQualityTracker();
    for (let i = 0; i < 20; i++) {
      fq.record({ orderId: `o${i}`, symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 100.01, timestamp: i });
    }
    expect(fq.recentRecords(5)).toHaveLength(5);
    expect(fq.recentRecords(5)[4].orderId).toBe('o19');
  });

  it('ignores fills with zero refPrice', () => {
    const fq = new FillQualityTracker();
    fq.record({ orderId: 'z', symbol: 'X', side: 'BUY', refPrice: 0, fillPrice: 100, timestamp: 1 });
    expect(fq.report().totalFills).toBe(0);
  });

  it('reports worst and best slippage', () => {
    const fq = new FillQualityTracker();
    fq.record({ orderId: 'a', symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 100.05, timestamp: 1 });
    fq.record({ orderId: 'b', symbol: 'X', side: 'BUY', refPrice: 100, fillPrice: 99.99, timestamp: 2 });

    const report = fq.report();
    expect(report.worstSlippageBps).toBeCloseTo(5, 1);
    expect(report.bestSlippageBps).toBeCloseTo(-1, 1);
  });
});
