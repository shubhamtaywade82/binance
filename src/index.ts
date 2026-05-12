import { MultiTimeframeStore } from './binance/multi-tf-store';
import { LocalOrderBook } from './binance/orderbook';
import { AggTradeTape } from './binance/trade-tape';
import { loadConfig } from './config';
import { createDashboardBridge, type DashboardBridge } from './dashboard/bridge';
import { createAppLogger } from './logging/app-logger';
import { HybridOrchestrator } from './orchestrator';
import { Lifecycle } from './lifecycle';

let orch: HybridOrchestrator | null = null;
let dashboardBridge: DashboardBridge | null = null;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createAppLogger(cfg);

  const lifecycle = new Lifecycle({
    defaultTimeoutMs: cfg.SHUTDOWN_TIMEOUT_MS,
    forceExitMs: cfg.SHUTDOWN_FORCE_EXIT_MS,
    log,
  });
  lifecycle.attachProcessHandlers(log);

  if (cfg.DASHBOARD_ENABLED) {
    const store = new MultiTimeframeStore({ maxBars: cfg.DASHBOARD_STORE_MAX_BARS });
    const orderbook = new LocalOrderBook();
    const tradeTape = new AggTradeTape(1000);
    dashboardBridge = createDashboardBridge(cfg, log, { store, orderbook, tradeTape });
    orch = new HybridOrchestrator(cfg, log, {
      store,
      orderbook,
      tradeTape,
      multiplexSidecar: dashboardBridge.multiplexSidecar,
    });
  } else {
    orch = new HybridOrchestrator(cfg, log);
  }

  const mx = orch.getMultiplexWs();
  if (mx) {
    lifecycle.register('multiplex_ws', () => mx.stop(), { timeoutMs: 3000 });
  }
  lifecycle.register('orchestrator', () => orch!.stop(), { timeoutMs: 3000 });
  if (dashboardBridge) {
    lifecycle.register('dashboard', () => dashboardBridge!.stop(), { timeoutMs: 3000 });
  }

  try {
    await orch.start();
    if (dashboardBridge) {
      await dashboardBridge.listen();
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
  if (dashboardBridge) {
    try {
      await dashboardBridge.stop();
    } catch {
      /* ignore */
    }
    dashboardBridge = null;
  }
  if (orch) {
    try {
      orch.stop();
    } catch {
      // ignore secondary failures during crash shutdown
    }
    orch = null;
  }
  process.exit(1);
});
