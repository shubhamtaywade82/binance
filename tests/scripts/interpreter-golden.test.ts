import { describe, expect, it } from 'vitest';
import { createContext, parse, prepare, runBar, tokenize } from '@coindcx/indicator-runtime';
import { ema as emaRef, rsi as rsiRef, atr as atrRef } from '../../src/strategy/indicators';
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

const runScript = (src: string, candles: Candle[]) => {
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

const plotValues = (ctx: any, name: string): number[] => {
  const out = ctx.outputs.get(name);
  if (!out) throw new Error(`No plot '${name}' in outputs`);
  return out.values.slice();
};

describe('interpreter golden — matches src/strategy/indicators.ts', () => {
  it('ema(close, 9) matches array-form EMA bar-for-bar', () => {
    const closes = Array.from({ length: 500 }, (_, i) => 100 + Math.sin(i / 7) * 5 + i * 0.01);
    const candles = mkCandles(closes);
    const ctx = runScript(
      'indicator("E")\nplot(ema(close, 9), title="e9")',
      candles,
    );
    const got = plotValues(ctx, 'e9');
    const ref = emaRef(closes, 9);
    expect(got.length).toBe(ref.length);
    for (let i = 0; i < ref.length; i++) {
      if (Number.isNaN(ref[i])) {
        expect(Number.isNaN(got[i])).toBe(true);
      } else {
        expect(got[i]).toBeCloseTo(ref[i], 9);
      }
    }
  });

  it('rsi(close, 14) matches array-form RSI', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const candles = mkCandles(closes);
    const ctx = runScript(
      'indicator("R")\nplot(rsi(close, 14), title="r14")',
      candles,
    );
    const got = plotValues(ctx, 'r14');
    const ref = rsiRef(closes, 14);
    expect(got.length).toBe(ref.length);
    for (let i = 0; i < ref.length; i++) {
      if (Number.isNaN(ref[i])) {
        expect(Number.isNaN(got[i])).toBe(true);
      } else {
        expect(got[i]).toBeCloseTo(ref[i], 9);
      }
    }
  });

  it('atr(14) matches array-form ATR', () => {
    const candles: Candle[] = Array.from({ length: 100 }, (_, i) => ({
      openTime: i * 60_000,
      open: 100 + Math.sin(i / 3),
      high: 102 + Math.sin(i / 3),
      low: 98 + Math.sin(i / 3),
      close: 100 + Math.sin(i / 3),
      volume: 1,
    }));
    const ctx = runScript('indicator("A")\nplot(atr(14), title="a14")', candles);
    const got = plotValues(ctx, 'a14');
    const ref = atrRef(candles, 14);
    expect(got.length).toBe(ref.length);
    for (let i = 0; i < ref.length; i++) {
      if (Number.isNaN(ref[i])) {
        expect(Number.isNaN(got[i])).toBe(true);
      } else {
        expect(got[i]).toBeCloseTo(ref[i], 9);
      }
    }
  });

  it('crossover() fires on actual EMA crosses', () => {
    // Build a series that ends with fast EMA(3) crossing above slow EMA(10).
    const closes = [
      ...Array.from({ length: 30 }, (_, i) => 100 - i * 0.5), // declining
      ...Array.from({ length: 30 }, (_, i) => 85 + i * 0.5), // rising
    ];
    const candles = mkCandles(closes);
    const ctx = runScript(
      [
        'indicator("X")',
        'fast = ema(close, 3)',
        'slow = ema(close, 10)',
        'plot(fast, title="fast")',
        'plot(slow, title="slow")',
        'plotshape(crossover(fast, slow), location="belowbar", color="lime", shape="triangleup", title="buy")',
      ].join('\n'),
      candles,
    );
    const buy = ctx.outputs.get('buy');
    expect(buy).toBeTruthy();
    expect(buy.markers.length).toBeGreaterThan(0);
  });
});
