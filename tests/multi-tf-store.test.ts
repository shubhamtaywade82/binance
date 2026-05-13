import { describe, expect, it, vi } from 'vitest';
import { MultiTimeframeStore } from '../src/binance/multi-tf-store';
import type { Candle } from '../src/types';

const c = (t: number, close = 1, high?: number, low?: number): Candle => ({
  openTime: t,
  open: close,
  high: high ?? close,
  low: low ?? close,
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

  it('prependOlder merges sorted and dedupes openTime (series row wins over same-time older fetch)', () => {
    const s = new MultiTimeframeStore();
    s.seed('X', '1m', [c(2000, 2), c(3000, 3)]);
    s.prependOlder('X', '1m', [c(500, 5), c(2000, 99)]);
    const out = s.getSeries('X', '1m');
    expect(out.map((x) => x.openTime)).toEqual([500, 2000, 3000]);
    expect(out.find((x) => x.openTime === 2000)!.close).toBe(2);
  });

  it('validateAgainstRest detects mismatched and missing bars', () => {
    const s = new MultiTimeframeStore();
    s.seed('X', '1m', [c(1000, 10), c(2000, 20), c(3000, 30)]);
    const restBars = [
      c(1000, 10),
      c(2000, 25),
      c(4000, 40),
    ];
    const { mismatched, missing } = s.validateAgainstRest('X', '1m', restBars);
    expect(mismatched).toEqual([2000]);
    expect(missing).toEqual([4000]);
  });

  it('validateAgainstRest returns empty when store matches REST', () => {
    const s = new MultiTimeframeStore();
    s.seed('X', '1m', [c(1000, 10), c(2000, 20)]);
    const { mismatched, missing } = s.validateAgainstRest('X', '1m', [c(1000, 10), c(2000, 20)]);
    expect(mismatched).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('reseedTail replaces tail while keeping older history', () => {
    const s = new MultiTimeframeStore();
    s.seed('X', '1m', [c(1000, 1), c(2000, 2), c(3000, 3), c(4000, 4)]);
    s.reseedTail('X', '1m', [c(3000, 33), c(4000, 44), c(5000, 55)]);
    const out = s.getSeries('X', '1m');
    expect(out.map((x) => x.openTime)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(out.find((x) => x.openTime === 3000)!.close).toBe(33);
    expect(out.find((x) => x.openTime === 1000)!.close).toBe(1);
  });

  it('fires onAnomalousBar when incoming range exceeds 8x median', () => {
    const spy = vi.fn();
    const s = new MultiTimeframeStore({ onAnomalousBar: spy });
    const bars: Candle[] = [];
    for (let i = 0; i < 25; i++) bars.push(c(i * 60_000, 100, 100.1, 99.9));
    s.seed('X', '1m', bars);
    s.applyKline('X', '1m', c(25 * 60_000, 100, 102, 98), false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe('X');
    expect(spy.mock.calls[0][1]).toBe('1m');
  });

  it('does not fire onAnomalousBar for normal range bars', () => {
    const spy = vi.fn();
    const s = new MultiTimeframeStore({ onAnomalousBar: spy });
    const bars: Candle[] = [];
    for (let i = 0; i < 25; i++) bars.push(c(i * 60_000, 100, 100.1, 99.9));
    s.seed('X', '1m', bars);
    s.applyKline('X', '1m', c(25 * 60_000, 100, 100.15, 99.85), false);
    expect(spy).not.toHaveBeenCalled();
  });
});
