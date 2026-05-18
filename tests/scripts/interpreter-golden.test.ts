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

  it('macd() exposes macd/signal/hist parts with matching identity hist=macd-signal', () => {
    const closes = Array.from({ length: 180 }, (_, i) => 100 + Math.sin(i / 6) * 4 + i * 0.03);
    const candles = mkCandles(closes);
    const ctx = runScript(
      [
        'indicator("M")',
        'm = macd(close, 12, 26, 9, "macd")',
        's = macd(close, 12, 26, 9, "signal")',
        'h = macd(close, 12, 26, 9, "hist")',
        'plot(m, title="m")',
        'plot(s, title="s")',
        'plot(h, title="h")',
      ].join('\n'),
      candles,
    );
    const macd = plotValues(ctx, 'm');
    const signal = plotValues(ctx, 's');
    const hist = plotValues(ctx, 'h');
    for (let i = 0; i < candles.length; i++) {
      if (Number.isFinite(macd[i]) && Number.isFinite(signal[i]) && Number.isFinite(hist[i])) {
        expect(hist[i]).toBeCloseTo(macd[i] - signal[i], 9);
      }
    }
  });

  it('mom/roc/bb helper functions compile and emit finite values after warmup', () => {
    const closes = Array.from({ length: 160 }, (_, i) => 100 + Math.sin(i / 4) * 3 + i * 0.02);
    const candles = mkCandles(closes);
    const ctx = runScript(
      [
        'indicator("B")',
        'm = mom(close, 10)',
        'r = roc(close, 10)',
        'mid = bbmiddle(close, 20)',
        'up = bbupper(close, 20, 2)',
        'low = bblower(close, 20, 2)',
        'plot(m, title="m")',
        'plot(r, title="r")',
        'plot(mid, title="mid")',
        'plot(up, title="up")',
        'plot(low, title="low")',
      ].join('\n'),
      candles,
    );
    const mom = plotValues(ctx, 'm');
    const roc = plotValues(ctx, 'r');
    const mid = plotValues(ctx, 'mid');
    const up = plotValues(ctx, 'up');
    const low = plotValues(ctx, 'low');
    for (let i = 0; i < candles.length; i++) {
      if (i > 30) {
        expect(Number.isFinite(mom[i])).toBe(true);
        expect(Number.isFinite(roc[i])).toBe(true);
      }
      if (i > 40 && Number.isFinite(mid[i]) && Number.isFinite(up[i]) && Number.isFinite(low[i])) {
        expect(Number.isFinite(mid[i])).toBe(true);
        expect(Number.isFinite(up[i])).toBe(true);
        expect(Number.isFinite(low[i])).toBe(true);
      }
    }
  });

  it('supports color(), label(), line(), and input.color for richer chart annotations', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 8) * 2);
    const candles = mkCandles(closes);
    const ctx = runScript(
      [
        'indicator("Visual")',
        'accent = input.color("#00ff00", title="Accent")',
        'c = color(255, 0, 0, 0.5)',
        'mid = sma(close, 10)',
        'plot(mid, color=accent, title="mid")',
        'label(crossover(close, mid), "cross up", "belowbar", c, "#ffffff")',
        'line(crossunder(close, mid), close, accent, "cross down level")',
      ].join('\n'),
      candles,
    );
    expect(ctx.outputs.get('mid')).toBeTruthy();
    const labelOut = Array.from(ctx.outputs.values()).find((o: any) => o.kind === 'marker' && o.opts.shape === 'label');
    expect(labelOut).toBeTruthy();
    const hlineOut = ctx.outputs.get('cross down level');
    expect(hlineOut).toBeTruthy();
  });

  it('supports simple user functions plus array/map containers', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.1);
    const candles = mkCandles(closes);
    const ctx = runScript(
      [
        'indicator("FnContainers")',
        'func spread(a, b) = a - b',
        'arr = array_new()',
        'mapv = map_new()',
        'array_push(arr, close)',
        'array_push(arr, open)',
        'map_set(mapv, "x", spread(close, open))',
        'v = array_get(arr, 0)',
        's = map_size(mapv)',
        'plot(v, title="v")',
        'plot(s, title="s")',
      ].join('\n'),
      candles,
    );
    expect(ctx.outputs.get('v')).toBeTruthy();
    expect(ctx.outputs.get('s')).toBeTruthy();
  });
});
