import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module
import { tokenize } from '../../ui/scripts/runtime/lexer.js';
// @ts-expect-error — JS module
import { parse } from '../../ui/scripts/runtime/parser.js';
// @ts-expect-error — JS module
import { prepare, runBar } from '../../ui/scripts/runtime/interpreter.js';
// @ts-expect-error — JS module
import { createContext } from '../../ui/scripts/runtime/context.js';
// @ts-expect-error — JS module
import { QuotaError, RuntimeError } from '../../ui/scripts/runtime/errors.js';

type Candle = { openTime: number; open: number; high: number; low: number; close: number; volume: number };

const mkCandles = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    openTime: i * 60_000,
    open: 100 + i,
    high: 100.5 + i,
    low: 99.5 + i,
    close: 100 + i,
    volume: 1,
  }));

describe('quotas', () => {
  it('caps TA len at the series capacity', () => {
    const src = 'indicator("X")\nplot(highest(close, 9999999))';
    const program = parse(tokenize(src));
    const ctx = createContext();
    prepare(program, ctx);
    const candles = mkCandles(5);
    // First bar should fail because len > MAX_LEN.
    ctx.pushBar(candles[0]);
    expect(() => runBar(program, ctx, 0)).toThrow(RuntimeError);
  });

  it('trips the per-bar node budget on deep expressions', () => {
    // Build a deeply nested + expression: 1+1+1+...+1
    const depth = 20_000;
    const src = `indicator("X")\nplot(${Array(depth).fill('1').join('+')})`;
    const program = parse(tokenize(src));
    const ctx = createContext({ nodeBudgetPerBar: 1_000 });
    prepare(program, ctx);
    ctx.pushBar(mkCandles(1)[0]);
    expect(() => runBar(program, ctx, 0)).toThrow(QuotaError);
  });

  it('rejects unknown identifiers at runtime', () => {
    const src = 'indicator("X")\nplot(foo)';
    const program = parse(tokenize(src));
    const ctx = createContext();
    prepare(program, ctx);
    ctx.pushBar(mkCandles(1)[0]);
    expect(() => runBar(program, ctx, 0)).toThrow(RuntimeError);
  });

  it('rejects unknown function calls', () => {
    const src = 'indicator("X")\nplot(supertrend_x(close, 9))';
    const program = parse(tokenize(src));
    const ctx = createContext();
    prepare(program, ctx);
    ctx.pushBar(mkCandles(1)[0]);
    expect(() => runBar(program, ctx, 0)).toThrow(RuntimeError);
  });
});
