/**
 * Deterministic replay CLI.
 *
 *   npx ts-node scripts/replay.ts \
 *     --from=2026-05-15T00:00:00Z \
 *     --to=2026-05-15T23:59:59Z \
 *     --symbol=SOLUSDT \
 *     --speed=100
 *
 * Replays recorded events through the EventBus → ActorSystem → RiskEngine →
 * ExecutionBridge (paper) end-to-end. EventStore write-back is intentionally
 * NOT re-enabled so replays don't pollute the source log.
 */
import { loadConfig } from '../src/config';
import { defaultEventBus } from '../src/core/events/event-bus';
import { PgWriter } from '../src/persistence/pg-writer';
import { EventStore } from '../src/persistence/event-store';
import { ReplayEngine } from '../src/replay/replay-engine';
import { ActorSystem } from '../src/core/actors/actor-system';
import { SignalToOrderBridge } from '../src/core/execution/signal-to-order-bridge';
import { ExecutionBridge } from '../src/core/execution/execution-bridge';
import { createExecutionRuntime } from '../src/execution/create-runtime';

interface Args {
  from: number;
  to: number;
  symbols: string[];
  speed: number;
}

function parseTs(v: string): number {
  const n = Number(v);
  if (!Number.isNaN(n) && n > 1e12) return n;
  const d = new Date(v).getTime();
  if (Number.isNaN(d)) throw new Error(`invalid timestamp: ${v}`);
  return d;
}

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  const now = Date.now();
  const from = out.from ? parseTs(out.from) : now - 24 * 3600_000;
  const to = out.to ? parseTs(out.to) : now;
  const speedRaw = out.speed ?? 'max';
  const speed = speedRaw === 'max' ? Infinity : Number(speedRaw);
  const symbols = (out.symbol || out.symbols || '').split(',').map(s => s.trim()).filter(Boolean);
  return { from, to, symbols, speed };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cfg = loadConfig();

  if (!cfg.POSTGRES_URL) {
    console.error('[replay] POSTGRES_URL required.');
    process.exit(2);
  }

  const pg = new PgWriter({ connectionString: cfg.POSTGRES_URL });
  await pg.connect();
  if (!pg.isConnected) {
    console.error('[replay] Postgres unavailable — cannot replay.');
    process.exit(2);
  }

  const eventStore = new EventStore(pg, defaultEventBus);

  // Build the same downstream graph as live. Forced paper mode for replay.
  const execution = createExecutionRuntime({ ...cfg, EXECUTION_MODE: 'paper' as any });
  const adapter = execution.paperAdapter ?? execution.adapter;
  if (!adapter) {
    console.error('[replay] No execution adapter available.');
    process.exit(2);
  }

  const actorSystem = new ActorSystem(cfg, defaultEventBus);
  for (const s of args.symbols) actorSystem.spawnSymbolActor(s);

  // SignalToOrderBridge needs a last-price oracle — derive from kline.closed.
  const lastPriceBySymbol = new Map<string, number>();
  defaultEventBus.subscribe('market.kline.closed', (e: any) => {
    if (e.symbol && e.payload?.close) lastPriceBySymbol.set(e.symbol, e.payload.close);
  });
  new SignalToOrderBridge(cfg, defaultEventBus, {
    lastPrice: (s) => lastPriceBySymbol.get(s) ?? null,
  });
  new ExecutionBridge(cfg, defaultEventBus, adapter);

  console.log(
    `[replay] from=${new Date(args.from).toISOString()} to=${new Date(args.to).toISOString()} ` +
    `symbols=${args.symbols.join(',') || '*'} speed=${args.speed === Infinity ? 'max' : args.speed}`,
  );

  let printed = 0;
  const result = await new ReplayEngine(eventStore, defaultEventBus).replay({
    fromTs: args.from,
    toTs: args.to,
    speedMultiplier: args.speed,
    onProgress: (_e, i, total) => {
      const step = Math.max(1, Math.floor(total / 20));
      if (i - printed >= step) { printed = i; console.log(`[replay] ${i}/${total}`); }
    },
  });

  console.log(`[replay] done dispatched=${result.dispatched} durationMs=${result.durationMs}`);
  await pg.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[replay] fatal:', err);
  process.exit(1);
});
