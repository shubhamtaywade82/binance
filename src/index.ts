import { loadConfig } from './config';
import { createAppLogger } from './logging/app-logger';
import { HybridOrchestrator } from './orchestrator';
import { Lifecycle } from './lifecycle';

let orch: HybridOrchestrator | null = null;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createAppLogger(cfg);

  const lifecycle = new Lifecycle({
    defaultTimeoutMs: cfg.SHUTDOWN_TIMEOUT_MS,
    forceExitMs: cfg.SHUTDOWN_FORCE_EXIT_MS,
    log,
  });
  lifecycle.attachProcessHandlers(log);

  orch = new HybridOrchestrator(cfg, log);
  const mx = orch.getMultiplexWs();
  if (mx) {
    lifecycle.register('multiplex_ws', () => mx.stop(), { timeoutMs: 3000 });
  }
  lifecycle.register('orchestrator', () => orch!.stop(), { timeoutMs: 3000 });

  try {
    await orch.start();
  } catch (err) {
    log.warn('startup_failed', { err: (err as Error).message });
    await lifecycle.shutdown('startup_error');
    orch = null;
    process.exit(1);
  }
}

main().catch(async (err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
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
