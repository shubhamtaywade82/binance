import { describe, expect, it } from 'vitest';
import { MultiTimeframeStore } from '../src/binance/multi-tf-store';
import { analyzeSmc } from '../src/strategy/smc';
import type { Candle } from '../src/types';

const bar = (openTime: number, close: number, opts: Partial<Candle> = {}): Candle => ({
  openTime,
  open: opts.open ?? close,
  high: opts.high ?? close + 0.5,
  low: opts.low ?? close - 0.5,
  close,
  volume: opts.volume ?? 100,
  sealed: opts.sealed,
});

describe('MultiTimeframeStore sealed-bar invariant (C-10)', () => {
  it('stamps incoming bars with sealed = isFinal', () => {
    const store = new MultiTimeframeStore();
    store.applyKline('SOLUSDT', '5m', bar(1000, 100), false);
    expect(store.latest('SOLUSDT', '5m')?.sealed).toBe(false);
    store.applyKline('SOLUSDT', '5m', bar(1000, 100.5), true);
    expect(store.latest('SOLUSDT', '5m')?.sealed).toBe(true);
  });

  it('refuses to overwrite a sealed bar with a non-final update at the same openTime', () => {
    const store = new MultiTimeframeStore();
    // First arrival: final close.
    store.applyKline('SOLUSDT', '5m', bar(1000, 100.5), true);
    // Late re-broadcast: same openTime, non-final, different close. Must be ignored.
    store.applyKline('SOLUSDT', '5m', bar(1000, 99.0), false);
    expect(store.latest('SOLUSDT', '5m')?.close).toBe(100.5);
    expect(store.latest('SOLUSDT', '5m')?.sealed).toBe(true);
  });

  it('still allows a non-final update to overwrite a non-final same-bar', () => {
    const store = new MultiTimeframeStore();
    store.applyKline('SOLUSDT', '5m', bar(1000, 100), false);
    store.applyKline('SOLUSDT', '5m', bar(1000, 100.3), false);
    expect(store.latest('SOLUSDT', '5m')?.close).toBe(100.3);
    expect(store.latest('SOLUSDT', '5m')?.sealed).toBe(false);
  });

  it('a final bar can overwrite the prior non-final partial', () => {
    const store = new MultiTimeframeStore();
    store.applyKline('SOLUSDT', '5m', bar(1000, 100), false);
    store.applyKline('SOLUSDT', '5m', bar(1000, 100.5), true);
    expect(store.latest('SOLUSDT', '5m')?.close).toBe(100.5);
    expect(store.latest('SOLUSDT', '5m')?.sealed).toBe(true);
  });

  it('forceApplyKline marks bars sealed', () => {
    const store = new MultiTimeframeStore();
    store.forceApplyKline('SOLUSDT', '5m', bar(1000, 100));
    expect(store.latest('SOLUSDT', '5m')?.sealed).toBe(true);
  });
});

describe('analyzeSmc FVG lookahead guard (C-10)', () => {
  it('never reports hasFvg when the lookahead bar is the unsealed live tip', () => {
    // Whatever SMC patterns the analyzer might find in a random-looking 60-bar
    // series, no orderBlock should report hasFvg=true if the neighbour bar
    // candles[i+1] used for the gap test is still forming (sealed=false).
    // We assert the invariant across many random seeds.
    for (let seed = 1; seed <= 5; seed++) {
      const candles: Candle[] = Array.from({ length: 60 }, (_, k) => {
        const close = 100 + Math.sin(k * 0.3 + seed) * 5 + (k % 7 === 0 ? 1.5 : 0);
        return bar(k * 60_000, close, {
          open: close - 0.3,
          high: close + 0.7,
          low: close - 0.7,
          // Only the LAST bar is the unsealed live tip; everything else is sealed history.
          sealed: k < 59,
        });
      });
      const result = analyzeSmc(candles, candles[59].close, 'LONG', { timeframe: '5m' });
      // Every flagged FVG must reference sealed neighbours; with only the last
      // bar unsealed, the analyzer cannot mark an FVG that involves index 59.
      // (Earlier indices may legitimately have FVGs — those are not affected.)
      for (const ob of result.orderBlocks) {
        if (ob.hasFvg) {
          // The gap reference is at ob.index ± 1; if ob.index === 58, then
          // candles[59] (live tip) was used and our guard should have suppressed.
          expect(ob.index).toBeLessThan(58);
        }
      }
    }
  });

  it('does not crash when the entire series is unsealed (degenerate replay case)', () => {
    const candles: Candle[] = Array.from({ length: 40 }, (_, k) => bar(k * 1000, 100 + k * 0.1, { sealed: false }));
    expect(() => analyzeSmc(candles, 104, 'LONG', { timeframe: '5m' })).not.toThrow();
  });
});
