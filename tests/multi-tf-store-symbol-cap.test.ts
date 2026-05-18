import { describe, expect, it, vi } from 'vitest';
import { MultiTimeframeStore } from '../src/binance/multi-tf-store';
import type { Candle } from '../src/types';

const bar = (openTime: number): Candle => ({
  openTime, open: 1, high: 1.5, low: 0.5, close: 1, volume: 10,
});

describe('MultiTimeframeStore symbol cap (M-1)', () => {
  it('starts under the cap (advisory by default — does not throw)', () => {
    const store = new MultiTimeframeStore({ maxSymbols: 3 });
    store.applyKline('SOL', '5m', bar(0), true);
    store.applyKline('ETH', '5m', bar(0), true);
    store.applyKline('BTC', '5m', bar(0), true);
    expect(store.symbolCount()).toBe(3);
    expect(store.isAtSymbolCap()).toBe(true);
  });

  it('FIRES onSymbolCapExceeded once when a new symbol arrives past the cap', () => {
    const onSymbolCapExceeded = vi.fn();
    const store = new MultiTimeframeStore({ maxSymbols: 2, onSymbolCapExceeded });
    store.applyKline('SOL', '5m', bar(0), true);
    store.applyKline('ETH', '5m', bar(0), true);
    // 3rd symbol triggers the callback.
    store.applyKline('BTC', '5m', bar(0), true);
    expect(onSymbolCapExceeded).toHaveBeenCalledOnce();
    expect(onSymbolCapExceeded).toHaveBeenCalledWith('BTC', 2, 2);
  });

  it('does not fire onSymbolCapExceeded again for the same already-rejected symbol', () => {
    const onSymbolCapExceeded = vi.fn();
    const store = new MultiTimeframeStore({ maxSymbols: 1, enforceSymbolCap: true, onSymbolCapExceeded });
    store.applyKline('SOL', '5m', bar(0), true);
    store.applyKline('ETH', '5m', bar(0), true);
    store.applyKline('ETH', '5m', bar(60_000), true);
    store.applyKline('ETH', '5m', bar(120_000), true);
    expect(onSymbolCapExceeded).toHaveBeenCalledTimes(1);
  });

  it('advisory mode (enforce=false): new symbols are still STORED beyond the cap', () => {
    const store = new MultiTimeframeStore({ maxSymbols: 2, enforceSymbolCap: false });
    store.applyKline('SOL', '5m', bar(0), true);
    store.applyKline('ETH', '5m', bar(0), true);
    store.applyKline('BTC', '5m', bar(0), true);
    expect(store.getSeries('BTC', '5m')).toHaveLength(1);
    expect(store.symbolCount()).toBe(3);
  });

  it('enforce=true: new symbols past the cap are NOT stored (read returns empty)', () => {
    const store = new MultiTimeframeStore({ maxSymbols: 2, enforceSymbolCap: true });
    store.applyKline('SOL', '5m', bar(0), true);
    store.applyKline('ETH', '5m', bar(0), true);
    store.applyKline('BTC', '5m', bar(0), true);
    expect(store.getSeries('BTC', '5m')).toHaveLength(0);
    expect(store.symbolCount()).toBe(2);
  });
});
