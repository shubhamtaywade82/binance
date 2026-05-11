import { describe, expect, it } from 'vitest';
import {
  buildCombinedStreamUrl,
  groupStreamsByRoute,
  normalizeWsRoot,
  routeForStream,
} from '../src/binance/ws-routing';

describe('USD-M Futures WebSocket routing (derivatives docs)', () => {
  it('splits bookTicker and depth to public; kline aggregate trades mark to market', () => {
    const streams = [
      'solusdt@kline_15m',
      'solusdt@bookTicker',
      'solusdt@depth@100ms',
      'solusdt@aggTrade',
      'solusdt@markPrice@1s',
    ];
    const g = groupStreamsByRoute('usdm', streams);
    expect(g.get('public')).toEqual(['solusdt@bookTicker', 'solusdt@depth@100ms']);
    expect(g.get('market')).toEqual([
      'solusdt@kline_15m',
      'solusdt@aggTrade',
      'solusdt@markPrice@1s',
    ]);
  });

  it('builds routed combined URLs from root host only', () => {
    const root = 'wss://fstream.binance.com';
    expect(
      buildCombinedStreamUrl(root, 'usdm', 'market', ['btcusdt@aggTrade']),
    ).toBe('wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade');
    expect(
      buildCombinedStreamUrl(root, 'usdm', 'public', ['btcusdt@depth@100ms']),
    ).toBe('wss://fstream.binance.com/public/stream?streams=btcusdt@depth@100ms');
  });

  it('normalizes user-supplied bases that already include /market or /public', () => {
    expect(normalizeWsRoot('wss://fstream.binance.com/market', 'usdm')).toBe(
      'wss://fstream.binance.com',
    );
    expect(normalizeWsRoot('wss://fstream.binance.com/public/stream', 'usdm')).toBe(
      'wss://fstream.binance.com',
    );
  });

  it('spot stays single-host stream mode', () => {
    expect(routeForStream('spot', 'btcusdt@trade')).toBe('spot');
    expect(buildCombinedStreamUrl('wss://stream.binance.com:9443', 'spot', 'spot', ['a@b'])).toBe(
      'wss://stream.binance.com:9443/stream?streams=a@b',
    );
  });
});
