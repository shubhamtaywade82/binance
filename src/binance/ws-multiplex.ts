import WebSocket from 'ws';
import type { Candle } from '../types';
import { normalizeBinanceKlineRow } from './rest-klines';
import type { DepthDiff } from './orderbook';
import {
  buildCombinedStreamUrl,
  groupStreamsByRoute,
  type BinanceProductWs,
  type BinanceWsRoute,
} from './ws-routing';

export type DepthLevels = 0 | 5 | 10 | 20;
export type DepthSpeed = '100ms' | '500ms';
export type { BinanceProductWs } from './ws-routing';

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
  onOpen?: (route: BinanceWsRoute, url: string) => void;
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

interface RouteConnection {
  route: BinanceWsRoute;
  ws: WebSocket | null;
  attempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  rotateTimer: ReturnType<typeof setTimeout> | null;
  subscriptions: Set<string>;
}

function isPartialDepthStream(stream: string | undefined): boolean {
  return stream !== undefined && /@depth(5|10|20)(@|$)/.test(stream.toLowerCase());
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
  private closed = false;
  private started = false;
  private nextId = 1;
  private connections = new Map<BinanceWsRoute, RouteConnection>();
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
    this.started = true;
    this.connectAll('initial');
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.started = false;
    for (const conn of this.connections.values()) {
      this.clearReconnectTimer(conn);
      this.clearRotateTimer(conn);
      if (!conn.ws) continue;
      const sock = conn.ws;
      conn.ws = null;
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
    for (const [route, routeStreams] of groupStreamsByRoute(this.opts.product, streams)) {
      const conn = this.ensureConnection(route);
      for (const stream of routeStreams) conn.subscriptions.add(stream);
      if (this.started && !conn.ws) this.connectRoute(conn, 'subscribe');
      this.send(conn, { method: 'SUBSCRIBE', params: routeStreams, id: this.nextId++ });
    }
  }

  unsubscribe(streams: string[]): void {
    if (streams.length === 0) return;
    for (const s of streams) this.subscriptions.delete(s);
    for (const [route, routeStreams] of groupStreamsByRoute(this.opts.product, streams)) {
      const conn = this.ensureConnection(route);
      for (const stream of routeStreams) conn.subscriptions.delete(stream);
      this.send(conn, { method: 'UNSUBSCRIBE', params: routeStreams, id: this.nextId++ });
    }
  }

  listSubscriptions(): void {
    for (const conn of this.connections.values()) {
      this.send(conn, { method: 'LIST_SUBSCRIPTIONS', id: this.nextId++ });
    }
  }

  /** Currently configured stream names. */
  streams(): string[] {
    return [...this.subscriptions];
  }

  private send(conn: RouteConnection, msg: SubscriptionMessage): void {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private connectAll(reason: string): void {
    if (this.closed) return;
    const grouped = groupStreamsByRoute(this.opts.product, this.subscriptions);
    for (const [route, streams] of grouped) {
      const conn = this.ensureConnection(route);
      conn.subscriptions = new Set(streams);
      this.connectRoute(conn, reason);
    }
  }

  private ensureConnection(route: BinanceWsRoute): RouteConnection {
    let conn = this.connections.get(route);
    if (!conn) {
      conn = {
        route,
        ws: null,
        attempt: 0,
        reconnectTimer: null,
        rotateTimer: null,
        subscriptions: new Set<string>(),
      };
      this.connections.set(route, conn);
    }
    return conn;
  }

  private connectRoute(conn: RouteConnection, reason: string): void {
    if (this.closed || conn.ws || conn.subscriptions.size === 0) return;
    this.clearReconnectTimer(conn);
    const list = [...conn.subscriptions];
    const url = buildCombinedStreamUrl(this.opts.baseWsUrl, this.opts.product, conn.route, list);
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    let socket: WebSocket;
    try {
      socket = factory(url);
    } catch (e) {
      this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      this.scheduleReconnect(conn, 'factory_error');
      return;
    }
    conn.ws = socket;

    socket.on('open', () => {
      conn.attempt = 0;
      this.scheduleRotate(conn);
      this.cb.onOpen?.(conn.route, url);
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
        this.handle(parsed, conn);
      } catch (e) {
        this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });

    socket.on('close', (code: number, buf: Buffer) => {
      if (conn.ws === socket) conn.ws = null;
      this.clearRotateTimer(conn);
      this.cb.onClose?.(code, buf?.toString() ?? '');
      if (!this.closed && conn.subscriptions.size > 0) {
        this.scheduleReconnect(conn, `close_${code}`);
      }
    });

    socket.on('error', (err: Error) => {
      this.cb.onError?.(err);
    });

    if (reason !== 'initial') this.cb.onReconnect?.(conn.attempt, `${conn.route}:${reason}`);
  }

  private handle(msg: Record<string, unknown>, conn: RouteConnection): void {
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
    if (evt === 'depthUpdate' && isPartialDepthStream(msg.stream as string | undefined)) {
      this.dispatchFuturesPartial(data);
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
      this.forceReconnect(conn, 'serverShutdown');
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

  private dispatchFuturesPartial(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    if (!symbol) return;
    this.cb.onDepthPartial?.({
      symbol,
      lastUpdateId: Number(data.u),
      bids: (data.b as [string, string][]) ?? [],
      asks: (data.a as [string, string][]) ?? [],
    });
  }

  private forceReconnect(conn: RouteConnection, reason: string): void {
    if (this.closed) return;
    if (conn.ws) {
      const sock = conn.ws;
      conn.ws = null;
      sock.removeAllListeners();
      try {
        sock.close(1012, reason);
      } catch {
        // ignore
      }
    }
    this.scheduleReconnect(conn, reason, 0);
  }

  private scheduleReconnect(conn: RouteConnection, reason: string, overrideMs?: number): void {
    if (this.closed || conn.reconnectTimer || conn.subscriptions.size === 0) return;
    conn.attempt += 1;
    const delayMs = overrideMs ?? Math.min(60_000, 500 * 2 ** Math.min(conn.attempt, 10));
    this.cb.onReconnect?.(conn.attempt, `${conn.route}:${reason}`);
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.connectRoute(conn, reason);
    }, delayMs);
    if (typeof conn.reconnectTimer.unref === 'function') conn.reconnectTimer.unref();
  }

  private clearReconnectTimer(conn: RouteConnection): void {
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
  }

  private scheduleRotate(conn: RouteConnection): void {
    this.clearRotateTimer(conn);
    conn.rotateTimer = setTimeout(() => {
      conn.rotateTimer = null;
      this.forceReconnect(conn, 'rotate_24h');
    }, this.reconnectAfterMs);
    if (typeof conn.rotateTimer.unref === 'function') conn.rotateTimer.unref();
  }

  private clearRotateTimer(conn: RouteConnection): void {
    if (conn.rotateTimer) {
      clearTimeout(conn.rotateTimer);
      conn.rotateTimer = null;
    }
  }
}
