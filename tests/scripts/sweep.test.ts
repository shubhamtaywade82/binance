import { describe, expect, it } from 'vitest';
import {
  tokenize,
  parse,
  prepare,
  runBar,
  createContext,
} from '@coindcx/indicator-runtime';

// Test the sweep loop's core: running the same program with different inputs and
// collecting stats. Mirrors what handleSweep does in the worker.
const mkCandles = (closes: number[]) =>
  closes.map((close, i) => ({
    openTime: i * 60_000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1,
  }));

const runVariant = (program: any, candles: any[], inputs: Record<string, unknown>) => {
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

describe('parameter sweep', () => {
  it('produces distinct stats for each input combination', () => {
    const src = [
      'strategy("S", initial_capital=1000)',
      'len = input.int(5, title="Len")',
      'fast = ema(close, len)',
      'entry(close > fast, "long")',
      'exit(close < fast)',
    ].join('\n');
    const program = parse(tokenize(src));
    const candles = mkCandles(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 10));
    const results = [];
    for (const len of [3, 5, 10, 20]) {
      results.push({ inputs: { len }, stats: runVariant(program, candles, { len }) });
    }
    // Every variant produces non-null stats and a finite total return.
    for (const r of results) {
      expect(r.stats).not.toBeNull();
      expect(Number.isFinite(r.stats!.totalReturn)).toBe(true);
    }
    // Different `len`s exercise different EMAs → different equity outcomes (very likely).
    const totalPnls = results.map((r) => r.stats!.totalPnl);
    const uniq = new Set(totalPnls.map((p) => p.toFixed(6)));
    expect(uniq.size).toBeGreaterThan(1);
  });
});
