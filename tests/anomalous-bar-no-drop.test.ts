import { describe, expect, it, vi } from 'vitest';
import { MultiTimeframeStore } from '../src/binance/multi-tf-store';
import type { Candle } from '../src/types';

const bar = (openTime: number, range = 1, close = 100): Candle => ({
  openTime,
  open: close - range / 2,
  high: close + range / 2,
  low: close - range / 2,
  close,
  volume: 100,
});

describe('MultiTimeframeStore anomalous bar handling (M-12)', () => {
  it('FIRES the onAnomalousBar callback for outsized bars (range > 8x median)', () => {
    const onAnomalousBar = vi.fn();
    const store = new MultiTimeframeStore({ onAnomalousBar });
    // Seed 25 normal bars with range=1.
    for (let i = 0; i < 25; i++) store.applyKline('SOL', '5m', bar(i * 60_000, 1), true);
    // Insert a 20x outlier.
    store.applyKline('SOL', '5m', bar(26 * 60_000, 20), true);
    expect(onAnomalousBar).toHaveBeenCalledOnce();
  });

  it('STILL STORES the anomalous bar instead of dropping it (M-12 vs pre-fix behaviour)', () => {
    const store = new MultiTimeframeStore({ onAnomalousBar: () => undefined });
    for (let i = 0; i < 25; i++) store.applyKline('SOL', '5m', bar(i * 60_000, 1), true);
    store.applyKline('SOL', '5m', bar(26 * 60_000, 20, 200), true); // anomalous + far close

    const series = store.getSeries('SOL', '5m');
    const last = series[series.length - 1];
    expect(last.openTime).toBe(26 * 60_000);
    expect(last.close).toBe(200);
  });

  it('returns true (success) even when the bar tripped the anomaly callback', () => {
    const store = new MultiTimeframeStore({ onAnomalousBar: () => undefined });
    for (let i = 0; i < 25; i++) store.applyKline('SOL', '5m', bar(i * 60_000, 1), true);
    const ok = store.applyKline('SOL', '5m', bar(26 * 60_000, 50), true);
    expect(ok).toBe(true);
  });
});
