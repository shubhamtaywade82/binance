import Redis from 'ioredis';
import { MultiTimeframeStore } from './binance/multi-tf-store';
import { LocalOrderBook } from './binance/orderbook';
import { AggTradeTape } from './binance/trade-tape';
import { loadConfig, multiplexBinanceSymbols } from './config';
import { createDashboardBridge, type DashboardBridge } from './dashboard/bridge';
import { createAppLogger } from './logging/app-logger';
import { HybridOrchestrator } from './orchestrator';
import { Lifecycle } from './lifecycle';
import { PerSymbolMarketFeeds } from './binance/per-symbol-market-feeds';
import { OrderBookSnapshotRing } from './liquidity/order-book-snapshot-ring';
import type { InstrumentPrecision } from './mapping/precision';
import { ControlHttpServer } from './control/http-server';
import { getRedisClient, closeRedisClient } from './services/redis';

let orch: HybridOrchestrator | null = null;
let dashboardBridge: DashboardBridge | null = null;
let controlServer: ControlHttpServer | null = null;

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const log = createAppLogger(cfg);

  if (cfg.BINANCE_FUTURES_TESTNET && cfg.BINANCE_PRODUCT === 'usdm') {
    log.warn('binance_testnet_liquidity_notice', {
      hint:
        'USD-M futures testnet has thin and unrealistic liquidity. Fills and slippage will not match mainnet; treat paper and testnet results as engineering checks only, not as live performance.',
    });
  }

  const lifecycle = new Lifecycle({
    defaultTimeoutMs: cfg.SHUTDOWN_TIMEOUT_MS,
    forceExitMs: cfg.SHUTDOWN_FORCE_EXIT_MS,
    log,
  });
  lifecycle.attachProcessHandlers(log);

  const orderBookSnapshotRing = new OrderBookSnapshotRing({
    depthLevels: Math.max(10, cfg.BINANCE_DEPTH_LEVELS || 20),
  });

  if (cfg.DASHBOARD_ENABLED) {
    const store = new MultiTimeframeStore({
      maxBars: cfg.DASHBOARD_STORE_MAX_BARS,
      onAnomalousBar: (symbol, tf, candle, medianRange) => {
        log.warn('anomalous_candle', {
          symbol,
          tf,
          openTime: new Date(candle.openTime).toISOString(),
          high: candle.high,
          low: candle.low,
          range: Math.abs(candle.high - candle.low),
          medianRange,
          ratio: medianRange > 0 ? (Math.abs(candle.high - candle.low) / medianRange).toFixed(1) : '∞',
        });
      },
    });
    const orderbook = new LocalOrderBook();
    const tradeTape = new AggTradeTape(1000);
    const precisionBySymbol = new Map<string, InstrumentPrecision>();
    const mxSyms = multiplexBinanceSymbols(cfg);
    const marketFeeds =
      mxSyms.length > 1
        ? new PerSymbolMarketFeeds(mxSyms, {
            tapeCapacity: 1000,
            primarySymbol: cfg.BINANCE_SYMBOL,
            primaryBook: orderbook,
            primaryTape: tradeTape,
          })
        : null;
    dashboardBridge = createDashboardBridge(cfg, log, {
      store,
      orderbook,
      tradeTape,
      marketFeeds,
      orderBookSnapshotRing,
      precisionBySymbol,
    });
    orch = new HybridOrchestrator(cfg, log, {
      store,
      orderbook,
      tradeTape,
      marketFeeds: marketFeeds ?? undefined,
      multiplexSidecar: dashboardBridge.multiplexSidecar,
      orderBookSnapshotRing,
      precisionBySymbol,
    });
  } else {
    orch = new HybridOrchestrator(cfg, log, { orderBookSnapshotRing });
  }

  const mx = orch.getMultiplexWs();
  if (mx) {
    lifecycle.register('multiplex_ws', () => mx.stop(), { timeoutMs: 3000 });
  }
  lifecycle.register('orchestrator', () => orch!.stop(), { timeoutMs: 3000 });
  if (dashboardBridge) {
    lifecycle.register('dashboard', () => dashboardBridge!.stop(), { timeoutMs: 3000 });
  }

  // ── Runtime control plane ───────────────────────────────────────────────
  const router = orch.getRouter();
  if (router && cfg.CONTROL_PORT > 0) {
    const redis = getRedisClient(cfg.REDIS_URL);
    controlServer = new ControlHttpServer(redis, router, () => orch!.hasPosition());

    // Subscribe to Redis pub/sub config changes (separate connection required for sub mode).
    if (cfg.REDIS_URL) {
      const redisSub = new Redis(cfg.REDIS_URL, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
      });
      redisSub.on('error', (err: Error) => {
        process.stderr.write(`redis_sub_error ${(err as Error).message}\n`);
      });
      controlServer.watchRedisConfigChanges(redisSub);
    }

    lifecycle.register('control_http', () => controlServer!.stop(), { timeoutMs: 3000 });
    lifecycle.register('redis', () => closeRedisClient(), { timeoutMs: 2000 });
  }

  try {
    await orch.start();
    if (dashboardBridge) {
      await dashboardBridge.listen();
    }
    if (controlServer) {
      await controlServer.listen(cfg.CONTROL_PORT);
      log.info('control_server_started', { port: cfg.CONTROL_PORT });
    }
  } catch (err) {
    log.warn('startup_failed', { err: (err as Error).message });
    await lifecycle.shutdown('startup_error');
    orch = null;
    dashboardBridge = null;
    process.exit(1);
  }
}

main().catch(async (err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  if (controlServer) {
    try { await controlServer.stop(); } catch { /* ignore */ }
    controlServer = null;
  }
  if (dashboardBridge) {
    try { await dashboardBridge.stop(); } catch { /* ignore */ }
    dashboardBridge = null;
  }
  if (orch) {
    try { orch.stop(); } catch { /* ignore */ }
    orch = null;
  }
  await closeRedisClient();
  process.exit(1);
});
