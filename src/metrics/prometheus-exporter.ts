import * as http from 'node:http';

export interface MetricsSnapshot {
  realizedPnl: number;
  unrealizedPnl: number;
  drawdownPct: number;
  winRate: number;
  totalTrades: number;
  sendLatencyMs: number[];
  slippageBps: number;
  mlPredictionAccuracy: number;
  wsReconnectsTotal: number;
  errorsTotal: number;
  uptimeSeconds: number;
}

export interface MetricsCollector {
  snapshot(): MetricsSnapshot;
}

const HISTOGRAM_BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function formatGauge(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
}

function formatCounter(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}\n`;
}

function formatHistogram(name: string, help: string, values: number[]): string {
  const lines: string[] = [];
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);

  let sum = 0;
  const bucketCounts = new Array<number>(HISTOGRAM_BUCKETS.length).fill(0);

  for (const v of values) {
    sum += v;
    for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
      if (v <= HISTOGRAM_BUCKETS[i]) {
        bucketCounts[i]++;
        break;
      }
    }
  }

  let cumulative = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
    cumulative += bucketCounts[i];
    lines.push(`${name}_bucket{le="${HISTOGRAM_BUCKETS[i]}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{le="+Inf"} ${values.length}`);
  lines.push(`${name}_sum ${sum}`);
  lines.push(`${name}_count ${values.length}`);

  return lines.join('\n') + '\n';
}

export function renderMetrics(collector: MetricsCollector): string {
  const s = collector.snapshot();
  const parts: string[] = [];

  parts.push(formatGauge('trading_realized_pnl', 'Cumulative realized PnL in USDT', s.realizedPnl));
  parts.push(formatGauge('trading_unrealized_pnl', 'Current unrealized PnL in USDT', s.unrealizedPnl));
  parts.push(formatGauge('trading_drawdown_pct', 'Current drawdown as a fraction', s.drawdownPct));
  parts.push(formatGauge('trading_win_rate', 'Win rate as a fraction', s.winRate));
  parts.push(formatGauge('trading_total_trades', 'Total closed trades', s.totalTrades));
  parts.push(formatHistogram('execution_send_latency_ms', 'Order send-to-ack latency in ms', s.sendLatencyMs));
  parts.push(formatGauge('execution_slippage_bps', 'Mean execution slippage in basis points', s.slippageBps));
  parts.push(formatGauge('ml_prediction_accuracy', 'ML model prediction accuracy', s.mlPredictionAccuracy));
  parts.push(formatCounter('system_ws_reconnects_total', 'Total WebSocket reconnections', s.wsReconnectsTotal));
  parts.push(formatCounter('system_errors_total', 'Total system errors', s.errorsTotal));
  parts.push(formatGauge('system_uptime_seconds', 'Bot uptime in seconds', s.uptimeSeconds));

  return parts.join('\n');
}

export function startMetricsServer(
  collector: MetricsCollector,
  port: number,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      const body = renderMetrics(collector);
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      res.end(body);
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, '0.0.0.0');
  return server;
}
