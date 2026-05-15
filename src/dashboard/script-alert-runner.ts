/**
 * Server-side NanoPine alert runner. Loads the JS runtime modules under
 * `ui/scripts/runtime/` via dynamic ESM import, runs scripts marked with
 * `runServerSide: true` against closed klines, and emits `script_alert` events to
 * a sink (typically the WebSocket broadcast in {@link createDashboardBridge}).
 *
 * Plots / shapes / hlines are ignored server-side — alerts are the only side
 * effect surfaced. This keeps the worker → server protocol minimal while still
 * delivering the "alerts even when no browser is open" promise.
 */
import type { Candle } from '../types';
import type { ScriptRecord } from './scripts-api';

export interface ScriptAlertEvent {
  scriptId: string;
  scriptName: string;
  message: string;
  bar: number;
  time: number | null;
  at: number;
}

export interface ScriptAlertRunnerOptions {
  /** Called with each alert event the running scripts produce. */
  onAlert: (event: ScriptAlertEvent) => void;
  /** Closed-bar TF the runner evaluates. Default '5m'. */
  evaluationTf?: string;
  /**
   * Override for the runtime module loader. The default uses `import()` via a
   * `new Function` shim that survives TypeScript's CJS rewriting; tests inject
   * a vitest-friendly loader so the dynamic-import-from-vm restriction doesn't
   * trip them up.
   */
  loadRuntimeModules?: () => Promise<unknown>;
  log?: { info?: (msg: string, ctx?: unknown) => void; warn?: (msg: string, ctx?: unknown) => void };
}

export interface ScriptAlertRunner {
  /** Replace the set of subscribed scripts. */
  setScripts(scripts: ScriptRecord[]): Promise<void>;
  /** Notify the runner of a closed bar at any TF — it filters internally. */
  onClosedBar(symbol: string, tf: string, candle: Candle): Promise<void>;
  /** Drop all runtimes. */
  dispose(): void;
}

// Dynamic ESM import that survives TS's CJS module transform.
const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;

interface Runtime {
  tokenize: (src: string) => unknown[];
  parse: (tokens: unknown[]) => unknown;
  prepare: (program: unknown, ctx: unknown) => void;
  runBar: (program: unknown, ctx: unknown, barIndex: number) => void;
  createContext: () => RuntimeContext;
}

interface RuntimeContext {
  meta: { kind?: string };
  strategy: unknown;
  times: number[];
  builtins: { close: { length(): number } };
  outputs: Map<string, { kind: string; events?: ScriptAlertSink[] }>;
  setInput(name: string, value: unknown): void;
  loadHtfData(byTf: Record<string, Candle[]>): void;
  pushBar(candle: Candle): void;
}

interface ScriptAlertSink {
  time: number | null;
  message: string;
  bar: number;
}

export function createScriptAlertRunner(opts: ScriptAlertRunnerOptions): ScriptAlertRunner {
  const evaluationTf = opts.evaluationTf || '5m';
  let runtime: Runtime | null = null;
  let loading: Promise<Runtime> | null = null;
  const states = new Map<
    string,
    {
      record: ScriptRecord;
      program: unknown;
      ctx: RuntimeContext;
      seenBarTimes: Set<number>;
      alertCounts: Map<string, number>;
    }
  >();

  const defaultLoader = async (): Promise<Runtime> => {
    // @coindcx/indicator-runtime is a workspace ESM package; CJS Node needs the dynamic
    // import shim to load it without TS rewriting it to require().
    const mod = (await dynImport('@coindcx/indicator-runtime')) as Record<string, unknown>;
    return {
      tokenize: mod.tokenize as Runtime['tokenize'],
      parse: mod.parse as Runtime['parse'],
      prepare: mod.prepare as Runtime['prepare'],
      runBar: mod.runBar as Runtime['runBar'],
      createContext: mod.createContext as Runtime['createContext'],
    };
  };

  const loadRuntime = async (): Promise<Runtime> => {
    if (runtime) return runtime;
    if (loading) return loading;
    loading = (async (): Promise<Runtime> => {
      const loaded = opts.loadRuntimeModules
        ? ((await opts.loadRuntimeModules()) as Runtime)
        : await defaultLoader();
      runtime = loaded;
      return runtime;
    })();
    return loading;
  };

  const compile = (rt: Runtime, record: ScriptRecord) => {
    const tokens = rt.tokenize(record.source);
    const program = rt.parse(tokens);
    const ctx = rt.createContext();
    const inputs = (record.inputs || {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(inputs)) ctx.setInput(name, value);
    rt.prepare(program, ctx);
    return { program, ctx };
  };

  return {
    async setScripts(scripts) {
      const rt = await loadRuntime();
      const next = new Map<string, ReturnType<typeof compile> & {
        record: ScriptRecord;
        seenBarTimes: Set<number>;
        alertCounts: Map<string, number>;
      }>();
      for (const sc of scripts) {
        if (!(sc as ScriptRecord & { runServerSide?: boolean }).runServerSide) continue;
        try {
          const { program, ctx } = compile(rt, sc);
          next.set(sc.id, {
            record: sc,
            program,
            ctx,
            seenBarTimes: new Set(),
            alertCounts: new Map(),
          });
        } catch (e) {
          opts.log?.warn?.('script_alert_compile_failed', {
            id: sc.id,
            err: (e as Error).message,
          });
        }
      }
      states.clear();
      for (const [id, s] of next.entries()) states.set(id, s);
      opts.log?.info?.('script_alert_runtime_loaded', {
        count: states.size,
        tf: evaluationTf,
      });
    },
    async onClosedBar(_symbol, tf, candle) {
      if (tf !== evaluationTf) return;
      if (!runtime || states.size === 0) return;
      const barTime = Math.floor(candle.openTime / 1000);
      for (const state of states.values()) {
        if (state.seenBarTimes.has(candle.openTime)) continue;
        state.seenBarTimes.add(candle.openTime);
        try {
          if (!Array.isArray(state.ctx.times)) state.ctx.times = [];
          state.ctx.times.push(barTime);
          state.ctx.pushBar(candle);
          const idx = state.ctx.builtins.close.length() - 1;
          runtime.runBar(state.program, state.ctx, idx);
          // Walk outputs for new alert events not previously delivered.
          for (const out of state.ctx.outputs.values()) {
            if (out.kind !== 'alert') continue;
            const events = (out.events || []) as ScriptAlertSink[];
            const seenKey = `events:${out['name' as keyof typeof out] ?? '?'}`;
            const prev = state.alertCounts.get(seenKey) ?? 0;
            for (let i = prev; i < events.length; i++) {
              const ev = events[i];
              opts.onAlert({
                scriptId: state.record.id,
                scriptName: state.record.name,
                message: ev.message,
                bar: ev.bar,
                time: ev.time,
                at: Date.now(),
              });
            }
            state.alertCounts.set(seenKey, events.length);
          }
        } catch (e) {
          opts.log?.warn?.('script_alert_runtime_error', {
            id: state.record.id,
            err: (e as Error).message,
          });
        }
      }
    },
    dispose() {
      states.clear();
    },
  };
}
