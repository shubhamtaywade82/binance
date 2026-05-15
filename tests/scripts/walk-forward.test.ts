/**
 * Walk-forward orchestration test. We don't spawn the actual Web Worker — instead
 * we re-import the runtime modules and replicate the worker's runVariant loop on
 * fixed slices, asserting that:
 *   1. Best train params survive into the test slice with the same evaluation logic.
 *   2. The window cursor advances correctly given (trainBars, testBars, stepBars).
 * This mirrors handleWalkForward's contract in ui/scripts/worker/script-worker.js.
 */
import { describe, expect, it } from 'vitest';
import {
  createContext,
  parse,
  prepare,
  runBar,
  tokenize,
} from '@coindcx/indicator-runtime';
import type { Candle } from '../../src/types';

const mkCandles = (closes: number[]): Candle[] =>
  closes.map((close, i) => ({
    openTime: i * 60_000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100,
  }));

const runVariant = (program: any, candles: Candle[], inputs: Record<string, unknown>) => {
  const ctx = createContext();
  for (const [name, value] of Object.entries(inputs)) ctx.setInput(name, value);
  prepare(program, ctx);
  ctx.times = candles.map((c) => Math.floor(c.openTime / 1000));
  for (let i = 0; i < candles.length; i++) {
    ctx.pushBar(candles[i]);
    runBar(program, ctx, i);
  }
  return ctx.meta.kind === 'strategy' && ctx.strategy ? ctx.strategyStats() : null;
};

const walkForward = (
  program: any,
  candles: Candle[],
  combinations: Array<Record<string, unknown>>,
  trainBars: number,
  testBars: number,
  stepBars: number,
) => {
  const total = candles.length;
  const windows: Array<{
    trainStart: number;
    trainEnd: number;
    testEnd: number;
    bestInputs: Record<string, unknown> | null;
    trainStats: any;
    testStats: any;
  }> = [];
  for (let start = 0; start + trainBars + testBars <= total; start += stepBars) {
    const trainSlice = candles.slice(start, start + trainBars);
    const testSlice = candles.slice(start + trainBars, start + trainBars + testBars);
    let bestInputs: Record<string, unknown> | null = null;
    let bestStats: any = null;
    for (const inputs of combinations) {
      const stats = runVariant(program, trainSlice, inputs);
      if (!stats) continue;
      if (!bestStats || stats.totalPnl > bestStats.totalPnl) {
        bestStats = stats;
        bestInputs = inputs;
      }
    }
    if (!bestInputs || !bestStats) continue;
    const testStats = runVariant(program, testSlice, bestInputs);
    windows.push({
      trainStart: start,
      trainEnd: start + trainBars,
      testEnd: start + trainBars + testBars,
      bestInputs,
      trainStats: bestStats,
      testStats,
    });
  }
  return windows;
};

describe('Phase 7 — walk-forward orchestration', () => {
  it('advances by stepBars across the candle history', () => {
    const program = parse(
      tokenize(
        [
          'strategy("X", initial_capital=1000)',
          'len = input.int(3, title="Len")',
          'fast = ema(close, len)',
          'entry(close > fast, "long")',
          'exit(close < fast)',
        ].join('\n'),
      ),
    );
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 4) * 5);
    const candles = mkCandles(closes);
    const windows = walkForward(program, candles, [{ len: 3 }, { len: 5 }], 80, 20, 20);
    // total=200, trainBars=80, testBars=20: first window covers 0..100, then step 20.
    // Available start positions: 0, 20, 40, 60, 80, 100 (start+100 <= 200 → start <= 100).
    expect(windows.map((w) => w.trainStart)).toEqual([0, 20, 40, 60, 80, 100]);
    for (const w of windows) {
      expect(w.bestInputs).not.toBeNull();
      expect(w.trainStats).not.toBeNull();
      expect(w.testStats).not.toBeNull();
    }
  });

  it('selects the highest-PnL train parameter set and reuses it on test', () => {
    const program = parse(
      tokenize(
        [
          'strategy("Y", initial_capital=1000)',
          'len = input.int(5, title="Len")',
          'fast = ema(close, len)',
          'entry(close > fast, "long")',
          'exit(close < fast)',
        ].join('\n'),
      ),
    );
    const closes = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 8);
    const candles = mkCandles(closes);
    const combos = [{ len: 3 }, { len: 6 }, { len: 12 }];
    const windows = walkForward(program, candles, combos, 60, 20, 20);
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      // Best inputs on train should match one of our candidates exactly.
      expect(combos).toContainEqual(w.bestInputs);
      // Test stats use the same winning inputs — re-running with the same inputs on
      // the test slice should be deterministic.
      const reRun = runVariant(program, candles.slice(w.trainEnd, w.testEnd), w.bestInputs!);
      expect(reRun?.totalPnl).toBeCloseTo(w.testStats.totalPnl, 9);
    }
  });
});
