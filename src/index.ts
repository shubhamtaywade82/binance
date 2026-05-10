import { loadConfig } from './config';
import { createAppLogger } from './logging/app-logger';
import { HybridOrchestrator } from './orchestrator';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const orch = new HybridOrchestrator(cfg, createAppLogger(cfg));
  await orch.start();

  const shutdown = () => {
    orch.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  process.exit(1);
});
