import http from 'http';
import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const botPnlGauge = new client.Gauge({ name: 'bot_pnl_usdt', help: 'Total realized PnL in USDT', registers: [register] });
export const botEquityGauge = new client.Gauge({ name: 'bot_equity_usdt', help: 'Current equity in USDT', registers: [register] });
export const botDrawdownGauge = new client.Gauge({ name: 'bot_drawdown_pct', help: 'Current drawdown fraction', registers: [register] });
export const botUnrealizedPnlGauge = new client.Gauge({ name: 'bot_unrealized_pnl_usdt', help: 'Unrealized PnL in USDT', registers: [register] });
export const botOpenPositionsGauge = new client.Gauge({ name: 'bot_open_positions', help: 'Number of open positions', registers: [register] });
export const botTradesCounter = new client.Counter({ name: 'bot_trades_total', help: 'Total trades', labelNames: ['side'] as const, registers: [register] });
export const botErrorsCounter = new client.Counter({ name: 'bot_errors_total', help: 'Total errors', labelNames: ['type'] as const, registers: [register] });
export const botOrderLatency = new client.Histogram({ name: 'bot_order_latency_ms', help: 'Order send latency ms', buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500], registers: [register] });
export const botInferenceLatency = new client.Histogram({ name: 'bot_inference_latency_ms', help: 'ML inference latency ms', buckets: [0.1, 0.5, 1, 2, 5, 10], registers: [register] });
export const botSlippageBps = new client.Histogram({ name: 'bot_slippage_bps', help: 'Fill slippage in basis points', buckets: [0.1, 0.5, 1, 2, 5, 10, 20], registers: [register] });

let server: http.Server | null = null;

export const startPrometheusServer = (port = 9090): void => {
  if (server) return;
  try {
    server = http.createServer(async (_req, res) => {
      try {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end();
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[prometheus] Port ${port} already in use, metrics server disabled. This is normal if another instance is running.`);
      } else {
        console.warn(`[prometheus] Server error: ${err.message}`);
      }
      server = null;
    });

    server.listen(port, () => {
      console.log(`[prometheus] Metrics server listening on :${port}`);
    });
  } catch (err) {
    console.warn(`[prometheus] Failed to initialize metrics server: ${(err as Error).message}`);
    server = null;
  }
};

export const stopPrometheusServer = (): void => {
  if (server) {
    server.close();
    server = null;
  }
};
