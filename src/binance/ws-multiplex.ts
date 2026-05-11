import WebSocket from 'ws';
import type { Candle } from '../types';
import { normalizeBinanceKlineRow } from './rest-klines';
import type { DepthDiff } from './orderbook';

export type DepthLevels = 0 | 5 | 10 | 20;
export type DepthSpeed = '100ms' | '1000ms';
export type BinanceProductWs = 'usdm' | 'spot';

export interface BookTickerEvent {
  symbol: string;
  updateId?: number;
  bestBid: number;
  bestBidQty: number;
  bestAsk: number;
  bestAskQty: number;
  ts: number;
}

export interface AggTradeEvent {
  symbol: string;
  aggTradeId?: number;
  price: number;
  qty: number;
  ts: number;
  /** Buyer is market maker (sell-aggressor). */
  makerSide: boolean;
}

export interface DepthPartialEvent {
  symbol: string;
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export interface MarkPriceMultiplexEvent {
  symbol: string;
  markPrice: number;
  eventTime: number;
}

export interface MultiplexCallbacks {
  onKline?: (symbol: string, interval: string, candle: Candle, isFinal: boolean) => void;
  onBookTicker?: (t: BookTickerEvent) => void;
  /** Spot 24h ticker — last price in `c`, same LTP role as USD-M mark. */
  on24hrTicker?: (u: { symbol: string; lastPrice: number; eventTime: number }) => void;
  onDepthPartial?: (p: DepthPartialEvent) => void;
  onDepthDiff?: (d: DepthDiff & { s: string }) => void;
  onAggTrade?: (t: AggTradeEvent) => void;
  onMarkPrice?: (u: MarkPriceMultiplexEvent) => void;
  onError?: (err: Error) => void;
  onReconnect?: (attempt: number, reason: string) => void;
  onServerShutdown?: () => void;
  onOpen?: () => void;
  onClose?: (code: number, reason: string) => void;
}

export interface MultiplexOptions {
  baseWsUrl: string;
  symbols: string[];
  timeframes: string[];
  product: BinanceProductWs;
  useBookTicker: boolean;
  useAggTrade: boolean;
  depthLevels: DepthLevels;
  depthSpeed: DepthSpeed;
  useMarkPrice: boolean;
  /** Hours before scheduled reconnect (Binance enforces 24h max). Default 23. */
  reconnectAfterHours?: number;
  /** Override constructor for tests. */
  wsFactory?: (url: string) => WebSocket;
}

interface SubscriptionMessage {
  method: 'SUBSCRIBE' | 'UNSUBSCRIBE' | 'LIST_SUBSCRIPTIONS';
  params?: string[];
  id: number;
}

export function buildStreamList(opts: MultiplexOptions): string[] {
  const out: string[] = [];
  for (const s of opts.symbols) {
    const lower = s.toLowerCase();
    for (const tf of opts.timeframes) out.push(`${lower}@kline_${tf}`);
    if (opts.product === 'spot') out.push(`${lower}@ticker`);
    if (opts.useBookTicker) out.push(`${lower}@bookTicker`);
    if (opts.depthLevels > 0) out.push(`${lower}@depth${opts.depthLevels}@${opts.depthSpeed}`);
    else out.push(`${lower}@depth@${opts.depthSpeed}`);
    if (opts.useAggTrade) out.push(`${lower}@aggTrade`);
    if (opts.useMarkPrice && opts.product === 'usdm') out.push(`${lower}@markPrice@1s`);
  }
  return out;
}

export class BinanceMultiplexWs {
  private ws: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private nextId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Set<string>;
  private readonly reconnectAfterMs: number;

  constructor(
    private readonly opts: MultiplexOptions,
    private cb: MultiplexCallbacks = {},
  ) {
    this.subscriptions = new Set(buildStreamList(opts));
    const hours = opts.reconnectAfterHours ?? 23;
    this.reconnectAfterMs = Math.max(60_000, hours * 60 * 60 * 1000);
  }

  setCallbacks(cb: MultiplexCallbacks): void {
    this.cb = cb;
  }

  start(): void {
    this.closed = false;
    this.connect('initial');
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    this.clearRotateTimer();
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      sock.removeAllListeners();
      try {
        sock.close(1000, 'shutdown');
      } catch {
        // ignore
      }
    }
  }

  /** Add streams at runtime. */
  subscribe(streams: string[]): void {
    if (streams.length === 0) return;
    for (const s of streams) this.subscriptions.add(s);
    this.send({ method: 'SUBSCRIBE', params: streams, id: this.nextId++ });
  }

  unsubscribe(streams: string[]): void {
    if (streams.length === 0) return;
    for (const s of streams) this.subscriptions.delete(s);
    this.send({ method: 'UNSUBSCRIBE', params: streams, id: this.nextId++ });
  }

  listSubscriptions(): void {
    this.send({ method: 'LIST_SUBSCRIPTIONS', id: this.nextId++ });
  }

  /** Currently configured stream names. */
  streams(): string[] {
    return [...this.subscriptions];
  }

  private send(msg: SubscriptionMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private connect(reason: string): void {
    if (this.closed) return;
    this.clearReconnectTimer();
    const base = this.opts.baseWsUrl.replace(/\/$/, '');
    const list = [...this.subscriptions].join('/');
    const url = `${base}/stream?streams=${list}`;
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    let socket: WebSocket;
    try {
      socket = factory(url);
    } catch (e) {
      this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      this.scheduleReconnect('factory_error');
      return;
    }
    this.ws = socket;

    socket.on('open', () => {
      this.attempt = 0;
      this.scheduleRotate();
      this.cb.onOpen?.();
    });

    socket.on('ping', (payload: Buffer) => {
      try {
        socket.pong(payload);
      } catch {
        // ws library handles default pong; ignore failures
      }
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        this.handle(parsed);
      } catch (e) {
        this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });

    socket.on('close', (code: number, buf: Buffer) => {
      this.ws = null;
      this.clearRotateTimer();
      this.cb.onClose?.(code, buf?.toString() ?? '');
      if (!this.closed) this.scheduleReconnect(`close_${code}`);
    });

    socket.on('error', (err: Error) => {
      this.cb.onError?.(err);
    });

    if (reason !== 'initial') this.cb.onReconnect?.(this.attempt, reason);
  }

  private handle(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'number' && (msg.result === null || Array.isArray(msg.result))) {
      // sub/unsub ack or LIST_SUBSCRIPTIONS response
      return;
    }

    let data: Record<string, unknown>;
    if (msg.stream && msg.data) data = msg.data as Record<string, unknown>;
    else data = msg;

    const evt = data.e as string | undefined;

    if (evt === 'kline') {
      this.dispatchKline(data);
      return;
    }
    if (evt === 'aggTrade') {
      this.dispatchAggTrade(data);
      return;
    }
    if (evt === 'markPriceUpdate') {
      this.dispatchMark(data);
      return;
    }
    if (evt === '24hrTicker') {
      this.dispatch24hrTicker(data);
      return;
    }
    if (evt === 'depthUpdate') {
      this.dispatchDiff(data);
      return;
    }
    if (evt === 'listenKeyExpired') {
      this.cb.onError?.(new Error('listenKeyExpired'));
      return;
    }
    // Server-shutdown signal: per Binance docs, sent ~10 min before maintenance.
    if (data.event === 'serverShutdown' || evt === 'serverShutdown') {
      this.cb.onServerShutdown?.();
      this.forceReconnect('serverShutdown');
      return;
    }
    // bookTicker may omit "e".
    if (data.b !== undefined && data.a !== undefined && data.s !== undefined) {
      this.dispatchBookTicker(data);
      return;
    }
    // Partial-depth payload: { lastUpdateId, bids, asks } and stream name carries symbol.
    if (typeof data.lastUpdateId === 'number' && Array.isArray(data.bids) && Array.isArray(data.asks)) {
      this.dispatchPartial(msg.stream as string | undefined, data);
      return;
    }
  }

  private dispatchKline(data: Record<string, unknown>): void {
    const k = data.k as Record<string, unknown> | undefined;
    if (!k) return;
    const candle = normalizeBinanceKlineRow([k.t, k.o, k.h, k.l, k.c, k.v, k.T]);
    if (!candle) return;
    const interval = String(k.i ?? '');
    const symbol = String(k.s ?? data.s ?? '').toUpperCase();
    this.cb.onKline?.(symbol, interval, candle, Boolean(k.x));
  }

  private dispatchBookTicker(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    const bid = Number(data.b);
    const ask = Number(data.a);
    if (!symbol || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
    this.cb.onBookTicker?.({
      symbol,
      updateId: Number(data.u ?? 0) || undefined,
      bestBid: bid,
      bestBidQty: Number(data.B),
      bestAsk: ask,
      bestAskQty: Number(data.A),
      ts: Number(data.T ?? data.E ?? Date.now()),
    });
  }

  private dispatchAggTrade(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    const price = Number(data.p);
    const qty = Number(data.q);
    if (!symbol || !Number.isFinite(price) || !Number.isFinite(qty)) return;
    this.cb.onAggTrade?.({
      symbol,
      aggTradeId: Number(data.a ?? 0) || undefined,
      price,
      qty,
      ts: Number(data.T ?? data.E ?? Date.now()),
      makerSide: Boolean(data.m),
    });
  }

  private dispatchMark(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    const markPrice = Number(data.p);
    if (!symbol || !Number.isFinite(markPrice)) return;
    this.cb.onMarkPrice?.({ symbol, markPrice, eventTime: Number(data.E ?? Date.now()) });
  }

  private dispatch24hrTicker(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    const lastPrice = Number(data.c);
    const eventTime = Number(data.E ?? Date.now());
    if (!symbol || !Number.isFinite(lastPrice)) return;
    this.cb.on24hrTicker?.({ symbol, lastPrice, eventTime });
  }

  private dispatchDiff(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    if (!symbol) return;
    this.cb.onDepthDiff?.({
      s: symbol,
      U: Number(data.U),
      u: Number(data.u),
      pu: data.pu === undefined ? undefined : Number(data.pu),
      E: data.E === undefined ? undefined : Number(data.E),
      bids: (data.b as Array<[string, string]>) ?? [],
      asks: (data.a as Array<[string, string]>) ?? [],
    });
  }

  private dispatchPartial(stream: string | undefined, data: Record<string, unknown>): void {
    const sym = stream ? stream.split('@')[0].toUpperCase() : '';
    this.cb.onDepthPartial?.({
      symbol: sym,
      lastUpdateId: Number(data.lastUpdateId),
      bids: (data.bids as [string, string][]) ?? [],
      asks: (data.asks as [string, string][]) ?? [],
    });
  }

  private forceReconnect(reason: string): void {
    if (this.closed) return;
    if (this.ws) {
      const sock = this.ws;
      this.ws = null;
      sock.removeAllListeners();
      try {
        sock.close(1012, reason);
      } catch {
        // ignore
      }
    }
    this.scheduleReconnect(reason, 0);
  }

  private scheduleReconnect(reason: string, overrideMs?: number): void {
    if (this.closed || this.reconnectTimer) return;
    this.attempt += 1;
    const delayMs = overrideMs ?? Math.min(60_000, 500 * 2 ** Math.min(this.attempt, 10));
    this.cb.onReconnect?.(this.attempt, reason);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(reason);
    }, delayMs);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleRotate(): void {
    this.clearRotateTimer();
    this.rotateTimer = setTimeout(() => {
      this.rotateTimer = null;
      this.forceReconnect('rotate_24h');
    }, this.reconnectAfterMs);
    if (typeof this.rotateTimer.unref === 'function') this.rotateTimer.unref();
  }

  private clearRotateTimer(): void {
    if (this.rotateTimer) {
      clearTimeout(this.rotateTimer);
      this.rotateTimer = null;
    }
  }
}
