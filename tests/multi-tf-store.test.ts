import { describe, expect, it } from 'vitest';
import { MultiTimeframeStore } from '../src/binance/multi-tf-store';
import type { Candle } from '../src/types';

const c = (t: number, close = 1): Candle => ({
  openTime: t,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});

describe('MultiTimeframeStore', () => {
  it('seeds, sorts, and dedupes by openTime', () => {
    const s = new MultiTimeframeStore();
    s.seed('SOLUSDT', '1m', [c(3000), c(1000), c(2000), c(2000, 9)]);
    const out = s.getSeries('SOLUSDT', '1m');
    expect(out.map((x) => x.openTime)).toEqual([1000, 2000, 3000]);
    expect(out[1].close).toBe(9);
  });

  it('applyKline upserts in-progress and appends final', () => {
    const s = new MultiTimeframeStore();
    s.seed('SOL', '1m', [c(1000, 1), c(2000, 2)]);
    s.applyKline('SOL', '1m', c(2000, 2.5), false);
    expect(s.latest('SOL', '1m')!.close).toBe(2.5);
    s.applyKline('SOL', '1m', c(3000, 3), true);
    expect(s.getSeries('SOL', '1m').map((x) => x.openTime)).toEqual([1000, 2000, 3000]);
  });

  it('caps series length to maxBars', () => {
    const s = new MultiTimeframeStore({ maxBars: 50 });
    const bars: Candle[] = [];
    for (let i = 0; i < 200; i += 1) bars.push(c(i * 1000, i));
    s.seed('X', '1m', bars);
    const out = s.getSeries('X', '1m');
    expect(out.length).toBe(50);
    expect(out[0].close).toBe(150);
  });

  it('exposes closes/has/latest', () => {
    const s = new MultiTimeframeStore();
    expect(s.has('X', '1m')).toBe(false);
    s.seed('X', '1m', [c(1, 1), c(2, 2)]);
    expect(s.has('X', '1m')).toBe(true);
    expect(s.closes('X', '1m')).toEqual([1, 2]);
    expect(s.latest('X', '1m')!.openTime).toBe(2);
  });
});
