import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module
import { tokenize } from '../../ui/scripts/runtime/lexer.js';
// @ts-expect-error — JS module
import { parse } from '../../ui/scripts/runtime/parser.js';
// @ts-expect-error — JS module
import { prepare, runBar } from '../../ui/scripts/runtime/interpreter.js';
// @ts-expect-error — JS module
import { createContext, tfDurationMs } from '../../ui/scripts/runtime/context.js';
// @ts-expect-error — JS module
import { RuntimeError } from '../../ui/scripts/runtime/errors.js';
import type { Candle } from '../../src/types';

const mkCandles = (openTimeMs: number, dtMs: number, closes: number[]): Candle[] =>
  closes.map((close, i) => ({
    openTime: openTimeMs + i * dtMs,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 100,
  }));

const runWithHtf = (src: string, ltf: Candle[], htfByTf: Record<string, Candle[]>) => {
  const program = parse(tokenize(src));
  const ctx = createContext();
  prepare(program, ctx);
  ctx.loadHtfData(htfByTf);
  ctx.times = ltf.map((c) => Math.floor(c.openTime / 1000));
  for (let i = 0; i < ltf.length; i++) {
    ctx.pushBar(ltf[i]);
    runBar(program, ctx, i);
  }
  return ctx;
};

describe('Phase 4 — security() multi-timeframe', () => {
  it('tfDurationMs covers common Binance timeframes', () => {
    expect(tfDurationMs('1m')).toBe(60_000);
    expect(tfDurationMs('5m')).toBe(300_000);
    expect(tfDurationMs('1h')).toBe(3_600_000);
    expect(tfDurationMs('4h')).toBe(14_400_000);
    expect(tfDurationMs('1d')).toBe(86_400_000);
  });

  it('returns NaN before any higher-TF bar has closed', () => {
    // 5m lower-TF bars starting at 09:00:00 UTC.
    const start = Date.UTC(2025, 0, 1, 9, 0, 0);
    const ltf = mkCandles(start, 300_000, [100, 101, 102, 103]);
    // No higher-TF candles supplied.
    const ctx = runWithHtf(
      'indicator("X")\nh = security("1h", "close")\nplot(h, title="h")',
      ltf,
      {},
    );
    const vals = ctx.outputs.get('h').values;
    for (const v of vals) expect(Number.isNaN(v)).toBe(true);
  });

  it('returns the latest closed higher-TF close with no lookahead', () => {
    // Higher TF: 1h candles starting at 08:00 and 09:00.
    const htfStart = Date.UTC(2025, 0, 1, 8, 0, 0);
    const htf1h: Candle[] = [
      { openTime: htfStart, open: 50, high: 51, low: 49, close: 50, volume: 1 },
      {
        openTime: htfStart + 3_600_000,
        open: 60,
        high: 61,
        low: 59,
        close: 60,
        volume: 1,
      },
    ];
    // Lower TF: 5m bars at 09:00, 09:05, 09:55, 10:00.
    const ltfStart = Date.UTC(2025, 0, 1, 9, 0, 0);
    const ltf: Candle[] = [
      { openTime: ltfStart, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      {
        openTime: ltfStart + 300_000,
        open: 101,
        high: 102,
        low: 100,
        close: 101,
        volume: 1,
      },
      {
        openTime: ltfStart + 11 * 300_000,
        open: 102,
        high: 103,
        low: 101,
        close: 102,
        volume: 1,
      },
      {
        openTime: ltfStart + 12 * 300_000,
        open: 103,
        high: 104,
        low: 102,
        close: 103,
        volume: 1,
      },
    ];
    const ctx = runWithHtf(
      'indicator("X")\nh = security("1h", "close")\nplot(h, title="h")',
      ltf,
      { '1h': htf1h },
    );
    const vals = ctx.outputs.get('h').values;
    // Bar 0 @ 09:00:00 → the 08:00 bar has just closed (08:00+1h = 09:00 ≤ 09:00). Use 50.
    // Bar 1 @ 09:05:00 → still 08:00 bar (09:00 bar hasn't closed yet). Use 50.
    // Bar 2 @ 09:55:00 → still 08:00 bar. Use 50.
    // Bar 3 @ 10:00:00 → 09:00 bar has now closed. Use 60.
    expect(vals).toEqual([50, 50, 50, 60]);
  });

  it('rejects unknown source names', () => {
    const ltfStart = Date.UTC(2025, 0, 1, 9, 0, 0);
    const ltf = mkCandles(ltfStart, 300_000, [100, 101]);
    const program = parse(tokenize('indicator("X")\nplot(security("1h", "garbage"))'));
    const ctx = createContext();
    prepare(program, ctx);
    ctx.loadHtfData({});
    ctx.times = ltf.map((c) => Math.floor(c.openTime / 1000));
    ctx.pushBar(ltf[0]);
    expect(() => runBar(program, ctx, 0)).toThrow(RuntimeError);
  });

  it('caches per-call-site state so security()[1] returns the previous bar value', () => {
    // 1h bars at 08:00, 09:00, 10:00 with distinct closes.
    const htfStart = Date.UTC(2025, 0, 1, 8, 0, 0);
    const htf1h: Candle[] = [
      { openTime: htfStart, open: 50, high: 51, low: 49, close: 50, volume: 1 },
      { openTime: htfStart + 3_600_000, open: 60, high: 61, low: 59, close: 60, volume: 1 },
      { openTime: htfStart + 7_200_000, open: 70, high: 71, low: 69, close: 70, volume: 1 },
    ];
    // 1h lower-TF bars exactly aligned to higher-TF (degenerate but easy to reason about).
    const ltfStart = Date.UTC(2025, 0, 1, 10, 0, 0);
    const ltf: Candle[] = [
      // At 10:00 → 09:00 hour just closed (close=60); 11:00 → 10:00 just closed (close=70).
      { openTime: ltfStart, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { openTime: ltfStart + 3_600_000, open: 101, high: 102, low: 100, close: 101, volume: 1 },
    ];
    const src = [
      'indicator("X")',
      'h  = security("1h", "close")',
      'h1 = h[1]',
      'plot(h,  title="h")',
      'plot(h1, title="h1")',
    ].join('\n');
    const ctx = runWithHtf(src, ltf, { '1h': htf1h });
    const h = ctx.outputs.get('h').values;
    const h1 = ctx.outputs.get('h1').values;
    expect(h).toEqual([60, 70]);
    // h[1] is the previous bar's h. On bar 0 there's no prior → NaN.
    expect(Number.isNaN(h1[0])).toBe(true);
    expect(h1[1]).toBe(60);
  });
});
