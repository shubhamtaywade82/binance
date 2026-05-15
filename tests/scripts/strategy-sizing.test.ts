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

describe('Phase 7 — strategy sizing modes', () => {
  it('cash sizing buys floor(amount / price) worth', () => {
    const src = [
      'strategy("Cash", initial_capital=10000)',
      'entry(close == 100, "long", sizing="cash", amount=1000)',
      'exit(close == 110)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 110]));
    const trades = ctx.strategy.trades;
    expect(trades).toHaveLength(1);
    // 1000 / 100 = 10 units. Long from 100 → 110 = +100.
    expect(trades[0].qty).toBeCloseTo(10, 9);
    expect(trades[0].pnl).toBeCloseTo(100, 9);
  });

  it('pct_equity sizing scales with the running equity', () => {
    const src = [
      'strategy("Pct", initial_capital=1000)',
      'entry(close == 100, "long", sizing="pct_equity", amount=0.5)',
      'exit(close == 120)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 110, 120]));
    const trades = ctx.strategy.trades;
    expect(trades).toHaveLength(1);
    // Equity at entry bar is 1000, 50% of equity = 500, at price 100 → 5 units.
    expect(trades[0].qty).toBeCloseTo(5, 9);
    // 5 * (120 - 100) = 100.
    expect(trades[0].pnl).toBeCloseTo(100, 9);
  });

  it('risk sizing computes qty from currentEquity * risk_pct / stopDistance', () => {
    const src = [
      'strategy("Risk", initial_capital=10000)',
      // Risk 1% = $100. Stop at 95, entry at 100 → stop distance 5 → qty 20.
      'entry(close == 100, "long", sizing="risk", risk_pct=0.01, stop=95)',
      'exit(close == 105)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 105]));
    const trades = ctx.strategy.trades;
    expect(trades).toHaveLength(1);
    expect(trades[0].qty).toBeCloseTo(20, 9);
    // qty=20, move 5 → 100 pnl.
    expect(trades[0].pnl).toBeCloseTo(100, 9);
  });

  it('risk sizing degenerates to 0 if stop is missing', () => {
    const src = [
      'strategy("RiskNoStop", initial_capital=10000)',
      'entry(close == 100, "long", sizing="risk", risk_pct=0.01)',
      'exit(close == 110)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 110]));
    expect(ctx.strategy.trades).toHaveLength(0);
    expect(ctx.strategy.position).toBeNull();
  });

  it('fixed sizing with explicit qty stays the default', () => {
    const src = [
      'strategy("Fixed", initial_capital=10000)',
      'entry(close == 100, "long", qty=3)',
      'exit(close == 110)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 110]));
    expect(ctx.strategy.trades[0].qty).toBe(3);
    expect(ctx.strategy.trades[0].pnl).toBeCloseTo(30, 9);
  });
});

describe('Phase 7 — fee and slippage modeling', () => {
  it('fee_pct deducts on both entry and exit notional', () => {
    const src = [
      'strategy("F", initial_capital=10000, fee_pct=0.001)',
      'entry(close == 100, "long", qty=1)',
      'exit(close == 110)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 110]));
    const t = ctx.strategy.trades[0];
    // Gross PnL = (110 - 100) * 1 = 10. Fees = 0.001 * (100 + 110) * 1 = 0.21. Net = 9.79.
    expect(t.pnl).toBeCloseTo(10 - 0.21, 9);
  });

  it('slippage adversely fills entry higher and exit lower for longs', () => {
    const src = [
      'strategy("S", initial_capital=10000, slippage_pct=0.001)',
      'entry(close == 100, "long", qty=1)',
      'exit(close == 110)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 110]));
    const t = ctx.strategy.trades[0];
    // Entry filled at 100 * 1.001 = 100.1. Exit at 110 * 0.999 = 109.89.
    expect(t.entryPrice).toBeCloseTo(100.1, 9);
    expect(t.exitPrice).toBeCloseTo(109.89, 9);
    expect(t.pnl).toBeCloseTo(109.89 - 100.1, 9);
  });

  it('fees + slippage stack on the same trade', () => {
    const src = [
      'strategy("FS", initial_capital=10000, fee_pct=0.0005, slippage_pct=0.001)',
      'entry(close == 100, "long", qty=1)',
      'exit(close == 110)',
    ].join('\n');
    const ctx = run(src, mkCandles([100, 110]));
    const t = ctx.strategy.trades[0];
    const expectedEntry = 100.1;
    const expectedExit = 109.89;
    const expectedFee = 0.0005 * (expectedEntry + expectedExit);
    expect(t.pnl).toBeCloseTo(expectedExit - expectedEntry - expectedFee, 9);
  });
});
