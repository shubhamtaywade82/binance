import { describe, expect, it } from 'vitest';
import { renderMetrics, type MetricsCollector, type MetricsSnapshot } from '../src/metrics/prometheus-exporter';

function stubCollector(overrides: Partial<MetricsSnapshot> = {}): MetricsCollector {
  return {
    snapshot: () => ({
      realizedPnl: 150.5,
      unrealizedPnl: -12.3,
      drawdownPct: 0.02,
      winRate: 0.63,
      totalTrades: 42,
      sendLatencyMs: [10, 25, 50, 100, 250],
      slippageBps: 1.8,
      mlPredictionAccuracy: 0.71,
      wsReconnectsTotal: 3,
      errorsTotal: 7,
      uptimeSeconds: 3600,
      ...overrides,
    }),
  };
}

describe('renderMetrics', () => {
  it('includes all expected gauge names', () => {
    const text = renderMetrics(stubCollector());
    const expectedGauges = [
      'trading_realized_pnl',
      'trading_unrealized_pnl',
      'trading_drawdown_pct',
      'trading_win_rate',
      'trading_total_trades',
      'execution_slippage_bps',
      'ml_prediction_accuracy',
      'system_uptime_seconds',
    ];
    for (const name of expectedGauges) {
      expect(text).toContain(name);
    }
  });

  it('includes counter metrics', () => {
    const text = renderMetrics(stubCollector());
    expect(text).toContain('system_ws_reconnects_total');
    expect(text).toContain('system_errors_total');
  });

  it('includes histogram with buckets for execution_send_latency_ms', () => {
    const text = renderMetrics(stubCollector());
    expect(text).toContain('# TYPE execution_send_latency_ms histogram');
    expect(text).toContain('execution_send_latency_ms_bucket{le="50"}');
    expect(text).toContain('execution_send_latency_ms_bucket{le="+Inf"}');
    expect(text).toContain('execution_send_latency_ms_sum');
    expect(text).toContain('execution_send_latency_ms_count');
  });

  it('renders correct gauge values', () => {
    const text = renderMetrics(stubCollector({ realizedPnl: 999.99, totalTrades: 100 }));
    expect(text).toContain('trading_realized_pnl 999.99');
    expect(text).toContain('trading_total_trades 100');
  });

  it('handles empty latency array', () => {
    const text = renderMetrics(stubCollector({ sendLatencyMs: [] }));
    expect(text).toContain('execution_send_latency_ms_count 0');
    expect(text).toContain('execution_send_latency_ms_sum 0');
  });

  it('histogram bucket counts are cumulative', () => {
    const text = renderMetrics(stubCollector({ sendLatencyMs: [5, 15, 60] }));

    const bucket10 = text.match(/execution_send_latency_ms_bucket\{le="10"\}\s+(\d+)/);
    const bucket25 = text.match(/execution_send_latency_ms_bucket\{le="25"\}\s+(\d+)/);
    const bucket100 = text.match(/execution_send_latency_ms_bucket\{le="100"\}\s+(\d+)/);
    const bucketInf = text.match(/execution_send_latency_ms_bucket\{le="\+Inf"\}\s+(\d+)/);

    expect(bucket10).not.toBeNull();
    expect(Number(bucket10![1])).toBe(1);
    expect(Number(bucket25![1])).toBe(2);
    expect(Number(bucket100![1])).toBe(3);
    expect(Number(bucketInf![1])).toBe(3);
  });

  it('uses correct Prometheus TYPE annotations', () => {
    const text = renderMetrics(stubCollector());
    expect(text).toContain('# TYPE trading_realized_pnl gauge');
    expect(text).toContain('# TYPE system_ws_reconnects_total counter');
    expect(text).toContain('# TYPE execution_send_latency_ms histogram');
  });
});
