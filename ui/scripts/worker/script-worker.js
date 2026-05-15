// NanoPine Web Worker.
//
// One worker process owns runtimes for many script instances, keyed by `instanceId`.
// Each runtime keeps its parsed Program, ExecutionContext, and a snapshot of marker
// counts (so delta detection on live bars is cheap).
//
// Message flow:
//   main → { kind:'compile_run', instanceId, source, inputs, candles }
//        ← { kind:'compiled', instanceId, meta, outputs, errors }
//   main → { kind:'bar', instanceId, candle }
//        ← { kind:'tick', instanceId, deltas }
//   main → { kind:'remove', instanceId }
//
// Any thrown error during compile/run is posted as { kind:'error', instanceId, error }.

import { tokenize, parse, prepare, runBar, createContext } from '@coindcx/indicator-runtime';
import { MSG } from './protocol.js';

const runtimes = new Map();

self.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  try {
    switch (msg.kind) {
      case MSG.COMPILE_RUN:
        handleCompileRun(msg);
        break;
      case MSG.BAR:
        handleBar(msg);
        break;
      case MSG.REMOVE:
        runtimes.delete(msg.instanceId);
        break;
      case MSG.SWEEP:
        handleSweep(msg);
        break;
      case MSG.WALK_FORWARD:
        handleWalkForward(msg);
        break;
      default:
        // Unknown — ignore silently.
        break;
    }
  } catch (err) {
    postError(msg.instanceId, err);
  }
});

function handleCompileRun(msg) {
  const { instanceId, source, inputs, candles, extraCandles } = msg;
  const tokens = tokenize(String(source ?? ''));
  const program = parse(tokens);

  const ctx = createContext();
  // Apply caller-supplied inputs before prepare() so the script's input.* defaults
  // don't overwrite user choices. coerce-on-prepare maps source names → Series.
  if (inputs && typeof inputs === 'object') {
    for (const [name, value] of Object.entries(inputs)) {
      ctx.setInput(name, value);
    }
  }
  prepare(program, ctx);
  // Higher-TF data for security() lookups (Phase 4). Optional — scripts that don't
  // call security() simply ignore this map.
  if (extraCandles && typeof extraCandles === 'object') {
    ctx.loadHtfData(extraCandles);
  }

  const n = Array.isArray(candles) ? candles.length : 0;
  ctx.times = new Array(n);
  for (let i = 0; i < n; i++) ctx.times[i] = candleTime(candles[i]);

  const startedAt = perfNow();
  for (let i = 0; i < n; i++) {
    ctx.pushBar(candles[i]);
    runBar(program, ctx, i);
    if (i % 256 === 0 && perfNow() - startedAt > ctx.fullHistoryBudgetMs) {
      throw new Error(
        `Script exceeded full-history budget ${ctx.fullHistoryBudgetMs}ms at bar ${i}/${n}`,
      );
    }
  }

  const outputs = ctx.snapshotOutputs();
  const counts = ctx.snapshotCounts();
  runtimes.set(instanceId, { program, ctx, counts });

  self.postMessage({
    kind: MSG.COMPILED,
    instanceId,
    meta: ctx.meta,
    outputs,
    bars: n,
  });
}

function runVariant(program, candles, inputs, extraCandles) {
  const ctx = createContext();
  for (const [name, value] of Object.entries(inputs)) ctx.setInput(name, value);
  prepare(program, ctx);
  if (extraCandles && typeof extraCandles === 'object') ctx.loadHtfData(extraCandles);
  const n = Array.isArray(candles) ? candles.length : 0;
  ctx.times = new Array(n);
  for (let i = 0; i < n; i++) ctx.times[i] = candleTime(candles[i]);
  for (let i = 0; i < n; i++) {
    ctx.pushBar(candles[i]);
    runBar(program, ctx, i);
  }
  return ctx.meta.kind === 'strategy' && ctx.strategy ? ctx.strategyStats() : null;
}

function handleSweep(msg) {
  const { sweepId, source, candles, extraCandles, combinations } = msg;
  const tokens = tokenize(String(source ?? ''));
  const program = parse(tokens);
  const results = [];
  const startedAt = perfNow();
  const MAX_MS = 30_000;
  for (const inputs of combinations || []) {
    if (perfNow() - startedAt > MAX_MS) break;
    try {
      const stats = runVariant(program, candles, inputs, extraCandles);
      results.push({ inputs, stats });
    } catch (err) {
      results.push({ inputs, error: (err && err.message) || String(err) });
    }
  }
  self.postMessage({ kind: MSG.SWEEP_RESULT, sweepId, results });
}

/**
 * Walk-forward backtest: slide a rolling (trainBars, testBars) window across the
 * candle history. For each window, sweep `combinations` on the train slice,
 * pick the input set with the highest total PnL, then evaluate that winner on
 * the contiguous test slice. Aggregates train + test stats per window so the
 * editor can show out-of-sample performance vs in-sample.
 */
function handleWalkForward(msg) {
  const { runId, source, candles, extraCandles, combinations, trainBars, testBars, stepBars } = msg;
  const tokens = tokenize(String(source ?? ''));
  const program = parse(tokens);
  const total = Array.isArray(candles) ? candles.length : 0;
  const train = Math.max(50, Math.floor(trainBars || 500));
  const test = Math.max(20, Math.floor(testBars || 100));
  const step = Math.max(10, Math.floor(stepBars || test));
  const windows = [];
  const startedAt = perfNow();
  const MAX_MS = 60_000;
  for (let start = 0; start + train + test <= total; start += step) {
    if (perfNow() - startedAt > MAX_MS) break;
    const trainSlice = candles.slice(start, start + train);
    const testSlice = candles.slice(start + train, start + train + test);
    let bestInputs = null;
    let bestStats = null;
    for (const inputs of combinations || []) {
      if (perfNow() - startedAt > MAX_MS) break;
      try {
        const stats = runVariant(program, trainSlice, inputs, extraCandles);
        if (!stats) continue;
        if (!bestStats || stats.totalPnl > bestStats.totalPnl) {
          bestStats = stats;
          bestInputs = inputs;
        }
      } catch {
        /* skip broken variants */
      }
    }
    if (!bestInputs || !bestStats) continue;
    let testStats = null;
    try {
      testStats = runVariant(program, testSlice, bestInputs, extraCandles);
    } catch {
      /* leave testStats null */
    }
    windows.push({
      trainStart: start,
      trainEnd: start + train,
      testEnd: start + train + test,
      bestInputs,
      trainStats: bestStats,
      testStats,
    });
  }
  self.postMessage({ kind: MSG.WALK_FORWARD_RESULT, runId, windows });
}

function handleBar(msg) {
  const { instanceId, candle } = msg;
  const rt = runtimes.get(instanceId);
  if (!rt) return; // silently drop bars for unknown instances
  const t0 = perfNow();
  rt.ctx.pushBar(candle);
  const idx = rt.ctx.builtins.close.length() - 1;
  // Append the candle's time to the times array so emit*() can stamp it.
  if (!Array.isArray(rt.ctx.times)) rt.ctx.times = [];
  rt.ctx.times[idx] = candleTime(candle);
  runBar(rt.program, rt.ctx, idx);
  const deltas = rt.ctx.snapshotDelta(rt.counts);
  rt.counts = rt.ctx.snapshotCounts();
  const elapsed = perfNow() - t0;
  if (elapsed > rt.ctx.liveBarBudgetMs * 5) {
    // Soft warning only — we don't kill the instance for one slow bar, but we let
    // the main thread surface it in dev tools if it wants.
    self.postMessage({
      kind: MSG.TICK,
      instanceId,
      deltas,
      warning: `Live bar took ${elapsed.toFixed(1)}ms (budget ${rt.ctx.liveBarBudgetMs}ms)`,
    });
    return;
  }
  self.postMessage({ kind: MSG.TICK, instanceId, deltas });
}

function postError(instanceId, err) {
  runtimes.delete(instanceId);
  const info = {
    name: err && err.name ? err.name : 'Error',
    message: err && err.message ? err.message : String(err),
    line: err && err.line,
    col: err && err.col,
    barIndex: err && err.barIndex,
  };
  self.postMessage({ kind: MSG.ERROR, instanceId, error: info });
}

function candleTime(candle) {
  // lightweight-charts wants seconds (UNIX) for time-scale.
  if (!candle) return 0;
  const t = candle.openTime ?? candle.time ?? 0;
  return Math.floor(t / 1000);
}

function perfNow() {
  // performance is available in Workers.
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();
}
