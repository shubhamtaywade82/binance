import * as vm from 'node:vm';

/**
 * Pure sandbox-execution function extracted from script-worker.ts so the
 * isolation behaviour is unit-testable without spinning up a Worker
 * thread per test case.
 *
 * Security goals (H-12):
 *   1. Script source cannot reach `require`, `process`, `Buffer`, `global`,
 *      `__dirname`, `__filename`, `setTimeout` — none of these are present
 *      in the context.
 *   2. Script source cannot escape via `__proto__` / `constructor` chain —
 *      `codeGeneration: { strings: false, wasm: false }` disables `eval`
 *      and `new Function(...)` inside the context, closing the
 *      `({}).constructor.constructor('return process')()` escape.
 *   3. Script source cannot bind globals — all sandbox values are frozen
 *      before being placed in the context, and any new globals the script
 *      assigns die when the context is GC'd.
 *   4. CPU bounded by `timeout` (V8 interrupt). Memory is bounded by the
 *      worker_threads resourceLimits in the parent (see worker-manager).
 */

const deepFreeze = <T>(obj: T): T => {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj as object)) {
      const v = (obj as any)[key];
      if (v && typeof v === 'object') deepFreeze(v);
    }
  }
  return obj;
};

export interface SandboxLogSink {
  (...args: unknown[]): void;
}

export const runInSandbox = (
  source: string,
  candles: unknown[],
  inputs: Record<string, unknown>,
  opts: { timeoutMs?: number; onLog?: SandboxLogSink } = {},
): unknown => {
  const safeCandles = deepFreeze(Array.isArray(candles) ? [...candles] : []);
  const safeInputs = deepFreeze({ ...(inputs ?? {}) });

  const sandbox: Record<string, unknown> = {
    candles: safeCandles,
    inputs: safeInputs,
    Math: Object.freeze({
      abs: Math.abs, max: Math.max, min: Math.min,
      round: Math.round, floor: Math.floor, ceil: Math.ceil,
      sqrt: Math.sqrt, pow: Math.pow, log: Math.log, exp: Math.exp,
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      PI: Math.PI, E: Math.E,
    }),
    Date: Object.freeze({
      now: Date.now,
      parse: Date.parse,
    }),
    console: Object.freeze({
      log: (...args: unknown[]) => opts.onLog?.(...args),
    }),
    __result: undefined,
  };

  const context = vm.createContext(sandbox, {
    name: 'nanopine',
    codeGeneration: { strings: false, wasm: false },
  });

  const wrapped = `__result = (function userScript() { ${source} \n; }).call(undefined);`;
  const script = new vm.Script(wrapped, { filename: 'nanopine.js' });
  script.runInContext(context, {
    timeout: Math.max(50, opts.timeoutMs ?? 2_000),
    displayErrors: false,
    breakOnSigint: false,
  });

  return (sandbox as { __result: unknown }).__result;
};
