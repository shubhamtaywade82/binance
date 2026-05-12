import { describe, expect, it, vi } from 'vitest';
import { mergeMultiplexCallbacks } from '../src/binance/merge-multiplex-callbacks';
import type { Candle } from '../src/types';

describe('mergeMultiplexCallbacks', () => {
  it('invokes primary before secondary for onKline', () => {
    const order: string[] = [];
    const candle: Candle = {
      openTime: 1,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
      closeTime: 2,
    };
    const merged = mergeMultiplexCallbacks(
      { onKline: () => order.push('a') },
      { onKline: () => order.push('b') },
    );
    merged.onKline?.('SOLUSDT', '5m', candle, true);
    expect(order).toEqual(['a', 'b']);
  });

  it('merges optional handlers so only defined sides run', () => {
    const a = vi.fn();
    const merged = mergeMultiplexCallbacks({}, { onError: a });
    merged.onError?.(new Error('x'));
    expect(a).toHaveBeenCalledTimes(1);
  });
});
