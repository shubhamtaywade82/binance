import { describe, expect, it } from 'vitest';
import {
  createContext,
  parse,
  prepare,
  runBar,
  RuntimeError,
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

const run = (src: string, candles: Candle[]) => {
  const program = parse(tokenize(src));
  const ctx = createContext();
  prepare(program, ctx);
  ctx.times = candles.map((c) => Math.floor(c.openTime / 1000));
  for (let i = 0; i < candles.length; i++) {
    ctx.pushBar(candles[i]);
    runBar(program, ctx, i);
  }
  return ctx;
};

describe('strategy declarations', () => {
  it('parses strategy() with initial_capital and seeds the strategy state', () => {
    const ctx = run(
      'strategy("S", initial_capital=5000)\nplot(close)',
      mkCandles([1, 2, 3]),
    );
    expect(ctx.meta.kind).toBe('strategy');
    expect(ctx.strategy).toBeTruthy();
    expect(ctx.strategy.initialCapital).toBe(5000);
    expect(ctx.strategy.equity.length).toBe(3);
    expect(ctx.strategy.equity[0]).toBe(5000);
  });

  it('rejects entry()/exit() in non-strategy scripts', () => {
    const src = 'indicator("I")\nentry(true, "long")';
    const program = parse(tokenize(src));
    const ctx = createContext();
    prepare(program, ctx);
    ctx.times = [0];
    ctx.pushBar(mkCandles([1])[0]);
    expect(() => runBar(program, ctx, 0)).toThrow(RuntimeError);
  });
});

describe('entry / exit semantics', () => {
  it('opens long on entry and computes positive PnL on rising close', () => {
    // Enter at bar 0 (close=100), price rises to 120 by bar 5.
    const closes = [100, 105, 110, 115, 120, 120];
    const src = [
      'strategy("S", initial_capital=1000)',
      'entry(close == 100, "long")',
      'exit(close == 120)',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    const stats = ctx.strategyStats();
    expect(stats.trades).toBe(1);
    expect(stats.totalPnl).toBeCloseTo(20, 9);
    expect(stats.totalReturn).toBeCloseTo(0.02, 9);
    expect(stats.winRate).toBe(1);
  });

  it('auto-reverses when entry is called with the opposite side', () => {
    const closes = [100, 110, 100, 90];
    const src = [
      'strategy("S", initial_capital=1000)',
      'entry(close == 100 and not (close[1] == 110), "long")',
      'entry(close == 110, "short")',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    const trades = ctx.strategy.trades;
    // Bar 0: enter long at 100. Bar 1: close 110 → close long (+10), open short at 110.
    // Bar 2: close 100 → would re-enter long but the OR condition skips because close[1]==110.
    // Actually the second `entry` only fires on close==110 (bar 1), so just one reverse there.
    expect(trades.length).toBe(1);
    expect(trades[0].pnl).toBeCloseTo(10, 9);
    expect(ctx.strategy.position?.side).toBe('short');
  });

  it('exit closes any open position at the bar close', () => {
    const closes = [100, 110, 90];
    const src = [
      'strategy("S", initial_capital=1000)',
      'entry(close == 100, "long")',
      'exit(close == 90)',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    expect(ctx.strategy.trades.length).toBe(1);
    expect(ctx.strategy.trades[0].pnl).toBeCloseTo(-10, 9);
    expect(ctx.strategy.position).toBeNull();
  });

  it('tracks open unrealized PnL in equity at every bar', () => {
    const closes = [100, 110, 105];
    const src = [
      'strategy("S", initial_capital=1000)',
      'entry(close == 100, "long")',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    // Bar 0: open at 100, equity = 1000 + 0 = 1000.
    // Bar 1: open long, unrealized = 110-100 = 10. equity = 1010.
    // Bar 2: unrealized = 105-100 = 5. equity = 1005.
    expect(ctx.strategy.equity).toEqual([1000, 1010, 1005]);
  });
});

describe('stats output snapshot', () => {
  it('emits stats and equity outputs in the snapshot', () => {
    const closes = [100, 105, 110];
    const src = [
      'strategy("S", initial_capital=1000)',
      'entry(close == 100, "long")',
      'exit(close == 110)',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    const outs = ctx.snapshotOutputs();
    const stats = outs.find((o: any) => o.kind === 'stats');
    const equity = outs.find((o: any) => o.name === '__strategy_equity');
    const markers = outs.find((o: any) => o.name === '__strategy_markers');
    expect(stats).toBeTruthy();
    expect(stats.stats.trades).toBe(1);
    expect(stats.stats.totalPnl).toBeCloseTo(10, 9);
    expect(equity).toBeTruthy();
    expect(equity.data.length).toBe(3);
    expect(markers).toBeTruthy();
    // Long marker on bar 0 + close marker on bar 2.
    expect(markers.markers.length).toBe(2);
  });
});
