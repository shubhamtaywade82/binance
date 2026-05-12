import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { BinanceMultiplexWs, buildStreamList } from '../src/binance/ws-multiplex';
import WebSocket from 'ws';

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  pongPayloads: Buffer[] = [];

  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }
  pong(payload: Buffer): void { this.pongPayloads.push(payload); }
}

function deliver(sock: FakeSocket, payload: Record<string, unknown>): void {
  sock.emit('message', Buffer.from(JSON.stringify(payload)));
}

describe('buildStreamList', () => {
  it('builds USDM streams for kline + bookTicker + diff depth + aggTrade + mark', () => {
    const list = buildStreamList({
      baseWsUrl: 'wss://x',
      symbols: ['SOLUSDT'],
      timeframes: ['15m', '1h'],
      product: 'usdm',
      useBookTicker: true,
      useAggTrade: true,
      depthLevels: 0,
      depthSpeed: '100ms',
      useMarkPrice: true,
    });
    expect(list).toEqual([
      'solusdt@kline_15m',
      'solusdt@kline_1h',
      'solusdt@ticker',
      'solusdt@bookTicker',
      'solusdt@depth@100ms',
      'solusdt@aggTrade',
      'solusdt@markPrice@1s',
    ]);
  });

  it('partial depth uses level when > 0; spot adds @ticker; no markPrice for spot', () => {
    const list = buildStreamList({
      baseWsUrl: 'wss://x',
      symbols: ['BTCUSDT'],
      timeframes: ['1m'],
      product: 'spot',
      useBookTicker: false,
      useAggTrade: false,
      depthLevels: 20,
      depthSpeed: '500ms',
      useMarkPrice: true,
    });
    expect(list).toContain('btcusdt@kline_1m');
    expect(list).toContain('btcusdt@ticker');
    expect(list).toContain('btcusdt@depth20@500ms');
    expect(list).not.toContain(expect.stringContaining('markPrice'));
  });
});

describe('BinanceMultiplexWs', () => {
  function build(cb = {}) {
    const sockets: Array<{ url: string; sock: FakeSocket }> = [];
    const mx = new BinanceMultiplexWs(
      {
        baseWsUrl: 'wss://fstream.binance.com',
        symbols: ['SOLUSDT'],
        timeframes: ['15m'],
        product: 'usdm',
        useBookTicker: true,
        useAggTrade: true,
        depthLevels: 20,
        depthSpeed: '100ms',
        useMarkPrice: true,
        wsFactory: (url) => {
          const sock = new FakeSocket();
          sockets.push({ url, sock });
          return sock as unknown as WebSocket;
        },
      },
      cb,
    );
    return { mx, sockets };
  }

  function socketFor(sockets: Array<{ url: string; sock: FakeSocket }>, route: 'market' | 'public'): FakeSocket {
    const found = sockets.find((s) => s.url.includes(`/${route}/`));
    if (!found) throw new Error(`missing ${route} socket`);
    return found.sock;
  }

  it('dispatches kline, bookTicker, aggTrade events', () => {
    const onKline = vi.fn();
    const onBookTicker = vi.fn();
    const onAggTrade = vi.fn();
    const onDepthPartial = vi.fn();
    const { mx, sockets } = build({ onKline, onBookTicker, onAggTrade, onDepthPartial });
    mx.start();
    const market = socketFor(sockets, 'market');
    const pub = socketFor(sockets, 'public');
    market.emit('open');
    pub.emit('open');

    expect(sockets.map((s) => s.url).sort()).toEqual([
      'wss://fstream.binance.com/market/stream?streams=solusdt@kline_15m/solusdt@ticker/solusdt@aggTrade/solusdt@markPrice@1s',
      'wss://fstream.binance.com/public/stream?streams=solusdt@bookTicker/solusdt@depth20@100ms',
    ]);

    deliver(market, {
      stream: 'solusdt@kline_15m',
      data: { e: 'kline', s: 'SOLUSDT', k: { t: 1, o: '1', h: '2', l: '0.5', c: '1.5', v: '10', T: 99, x: true, i: '15m', s: 'SOLUSDT' } },
    });
    deliver(pub, {
      stream: 'solusdt@bookTicker',
      data: { s: 'SOLUSDT', b: '100', B: '5', a: '101', A: '6', T: 1234 },
    });
    deliver(pub, {
      stream: 'solusdt@depth20@100ms',
      data: { e: 'depthUpdate', s: 'SOLUSDT', u: 42, b: [['100', '1']], a: [['101', '2']] },
    });
    deliver(market, {
      stream: 'solusdt@aggTrade',
      data: { e: 'aggTrade', s: 'SOLUSDT', p: '99', q: '0.5', T: 5000, m: true },
    });

    expect(onKline).toHaveBeenCalledWith('SOLUSDT', '15m', expect.objectContaining({ close: 1.5 }), true);
    expect(onBookTicker).toHaveBeenCalledWith(expect.objectContaining({ bestBid: 100, bestAsk: 101 }));
    expect(onDepthPartial).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'SOLUSDT', lastUpdateId: 42 }));
    expect(onAggTrade).toHaveBeenCalledWith(expect.objectContaining({ price: 99, makerSide: true }));

    void mx.stop();
  });

  it('responds to server ping with pong (echo payload)', () => {
    const { mx, sockets } = build();
    mx.start();
    const sock = socketFor(sockets, 'market');
    sock.emit('open');
    const payload = Buffer.from('binance');
    sock.emit('ping', payload);
    expect(sock.pongPayloads.length).toBe(1);
    expect(sock.pongPayloads[0].toString()).toBe('binance');
    void mx.stop();
  });

  it('serverShutdown triggers reconnect callback', () => {
    const onServerShutdown = vi.fn();
    const onReconnect = vi.fn();
    const { mx, sockets } = build({ onServerShutdown, onReconnect });
    mx.start();
    const sock = socketFor(sockets, 'public');
    sock.emit('open');
    deliver(sock, { stream: 'solusdt@bookTicker', data: { event: 'serverShutdown' } });
    expect(onServerShutdown).toHaveBeenCalled();
    expect(onReconnect).toHaveBeenCalled();
    void mx.stop();
  });

  it('subscribe/unsubscribe send correct JSON method messages', () => {
    const { mx, sockets } = build();
    mx.start();
    const pub = socketFor(sockets, 'public');
    pub.emit('open');
    mx.subscribe(['xrpusdt@bookTicker']);
    mx.unsubscribe(['xrpusdt@bookTicker']);
    expect(pub.sent.length).toBe(2);
    const sub = JSON.parse(pub.sent[0]);
    const unsub = JSON.parse(pub.sent[1]);
    expect(sub.method).toBe('SUBSCRIBE');
    expect(sub.params).toEqual(['xrpusdt@bookTicker']);
    expect(unsub.method).toBe('UNSUBSCRIBE');
    expect(typeof sub.id).toBe('number');
    void mx.stop();
  });

  it('ignores subscription ack { id, result: null }', () => {
    const onError = vi.fn();
    const { mx, sockets } = build({ onError });
    mx.start();
    const sock = socketFor(sockets, 'market');
    sock.emit('open');
    deliver(sock, { id: 1, result: null });
    expect(onError).not.toHaveBeenCalled();
    void mx.stop();
  });

  it('schedules a 23h rotation timer on connect', () => {
    vi.useFakeTimers();
    try {
      const onReconnect = vi.fn();
      const { mx, sockets } = build({ onReconnect });
      mx.start();
      for (const { sock } of sockets) sock.emit('open');
      vi.advanceTimersByTime(23 * 60 * 60 * 1000 + 100);
      expect(onReconnect).toHaveBeenCalled();
      void mx.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
