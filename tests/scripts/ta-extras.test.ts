import { describe, expect, it } from 'vitest';
import { createContext, parse, prepare, runBar, tokenize } from '@coindcx/indicator-runtime';
import type { Candle } from '../../src/types';

const mkCandles = (closes: number[], vols?: number[]): Candle[] =>
  closes.map((close, i) => ({
    openTime: i * 60_000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: vols ? vols[i] : 100,
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

const lastValue = (ctx: any, name: string): number => {
  const out = ctx.outputs.get(name);
  if (!out) throw new Error(`No plot '${name}'`);
  return out.values[out.values.length - 1];
};

describe('Phase 2 TA built-ins', () => {
  it('stdev(close, len) matches population stdev formula', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5 + Math.sin(i));
    const ctx = run(
      'indicator("S")\nplot(stdev(close, 10), title="s10")',
      mkCandles(closes),
    );
    // Compute reference population stdev for the last 10 closes.
    const last10 = closes.slice(-10);
    const mean = last10.reduce((s, v) => s + v, 0) / 10;
    const popStd = Math.sqrt(last10.reduce((s, v) => s + (v - mean) ** 2, 0) / 10);
    expect(lastValue(ctx, 's10')).toBeCloseTo(popStd, 9);
  });

  it('sum(close, len) equals plain rolling sum', () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    const ctx = run('indicator("X")\nplot(sum(close, 5), title="s5")', mkCandles(closes));
    // last 5 closes: 16,17,18,19,20 → 90
    expect(lastValue(ctx, 's5')).toBe(90);
  });

  it('wma(close, 5) is weighted toward the most recent value', () => {
    const closes = Array.from({ length: 10 }, () => 1);
    closes.push(11); // make the latest sample much larger
    const ctx = run('indicator("X")\nplot(wma(close, 5), title="w5")', mkCandles(closes));
    // wma over [1,1,1,1,11] weights 1,2,3,4,5 → num=1+2+3+4+55=65, denom=15 → 65/15
    expect(lastValue(ctx, 'w5')).toBeCloseTo(65 / 15, 9);
  });

  it('vwma(close, 5) weights by volume', () => {
    const closes = [100, 100, 100, 100, 100];
    const volumes = [1, 1, 1, 1, 10];
    const ctx = run(
      'indicator("X")\nplot(vwma(close, 5), title="v5")',
      mkCandles(closes, volumes),
    );
    // Sum p*v = 100*1+100*1+100*1+100*1+100*10 = 1400; sum v = 14 → 100
    expect(lastValue(ctx, 'v5')).toBe(100);
  });

  it('rising(close, 3) only true when strictly monotonic up over last 3 bars', () => {
    const closes = [10, 11, 12, 13, 13, 14, 15, 16];
    const ctx = run(
      'indicator("X")\nplot(rising(close, 3) ? 1 : 0, title="r")',
      mkCandles(closes),
    );
    const out = ctx.outputs.get('r').values;
    // last three closes (14,15,16) are strictly rising
    expect(out[out.length - 1]).toBe(1);
    // index 4: closes are 11,12,13,13 — (12<13, 13 not < 13) → falling false, rising false
    expect(out[4]).toBe(0);
  });

  it('falling(close, 3) detects monotonic down', () => {
    const closes = [10, 9, 8, 7, 6];
    const ctx = run(
      'indicator("X")\nplot(falling(close, 3) ? 1 : 0, title="f")',
      mkCandles(closes),
    );
    const out = ctx.outputs.get('f').values;
    expect(out[out.length - 1]).toBe(1);
  });
});

describe('Phase 2 plot styles and pane routing', () => {
  it('plot(..., style="histogram") emits a histogram output', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const src = [
      'indicator("X")',
      'd = close - ema(close, 5)',
      'plot(d, style="histogram", title="hist")',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    const out = ctx.outputs.get('hist');
    expect(out.kind).toBe('histogram');
    expect(out.values.length).toBe(20);
  });

  it('indicator(overlay=false) routes plots to pane 1 by default', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const src = [
      'indicator("X", overlay=false)',
      'plot(rsi(close, 5), title="r5")',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    const out = ctx.outputs.get('r5');
    expect(out.opts.pane).toBe(1);
  });

  it('explicit pane= overrides the indicator default', () => {
    const src = [
      'indicator("X", overlay=false)',
      'plot(close, pane=0, title="p0")',
      'plot(ema(close, 3), title="p1")',
    ].join('\n');
    const ctx = run(src, mkCandles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(ctx.outputs.get('p0').opts.pane).toBe(0);
    expect(ctx.outputs.get('p1').opts.pane).toBe(1);
  });
});

describe('Phase 2 alerts', () => {
  it('alert(cond, msg) emits events on bars where cond is true', () => {
    const closes = [1, 2, 1, 3, 2, 4]; // crosses-up pattern
    const src = [
      'indicator("X")',
      'up = close > close[1]',
      'alert(up, "Up bar")',
    ].join('\n');
    const ctx = run(src, mkCandles(closes));
    const alertOuts = Array.from(ctx.outputs.values()).filter((o: any) => o.kind === 'alert');
    expect(alertOuts.length).toBe(1);
    const events = (alertOuts[0] as any).events;
    // Bars where close > close[1]: indices 1, 3, 5 (closes 2>1, 3>1, 4>2). Bar 0 has NaN prev → false.
    expect(events.length).toBe(3);
    expect(events[0].message).toBe('Up bar');
  });
});
