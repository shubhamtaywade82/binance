import WebSocket from 'ws';
import type { Candle } from '../types';
import { isBinanceUsdmProduct } from '../config';
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
  /** Current funding rate from markPrice stream (field `r`). May be 0 if not present. */
  fundingRate: number;
}

/** Normalized `@ticker` / 24hrTicker fields (Binance `c` last, `p` change, `P` % string). */
export interface Ticker24hrEvent {
  symbol: string;
  lastPrice: number;
  eventTime: number;
  /** Absolute change vs 24h open (`p`). */
  priceChange?: number;
  /** Signed percent change as displayed (e.g. +1.23 from `P`). */
  priceChangePercent?: number;
  /** 24h open (`o`). */
  openPrice?: number;
  /** 24h high (`h`). */
  highPrice?: number;
  /** 24h low (`l`). */
  lowPrice?: number;
}

/** Liquidation order (forceOrder stream). */
export interface ForceOrderEvent {
  symbol: string;
  side: string;
  orderType: string;
  timeInForce: string;
  origQty: string;
  price: string;
  avgPrice: string;
  orderStatus: string;
  lastFilledQty: string;
  filledAccumulatedQty: string;
  tradeTime: number;
}

/** Mini ticker event — lightweight subset of 24hrTicker. */
export interface MiniTickerEvent {
  symbol: string;
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  eventTime: number;
}

/** Contract info event — listing/delisting notifications. */
export interface ContractInfoEvent {
  symbol: string;
  pair: string;
  contractType: string;
  deliveryDate: number;
  onboardDate: number;
  contractStatus: string;
  eventTime: number;
}

export interface MultiplexCallbacks {
  onKline?: (symbol: string, interval: string, candle: Candle, isFinal: boolean) => void;
  onBookTicker?: (t: BookTickerEvent) => void;
  /** Spot / USD-M 24h ticker — last in `c` (LTP); optional `p`/`P`/`o` for stats. */
  on24hrTicker?: (u: Ticker24hrEvent) => void;
  /** Mini ticker — lightweight 24h stats per symbol. */
  onMiniTicker?: (u: MiniTickerEvent) => void;
  onDepthPartial?: (p: DepthPartialEvent) => void;
  onDepthDiff?: (d: DepthDiff & { s: string }) => void;
  onAggTrade?: (t: AggTradeEvent) => void;
  onMarkPrice?: (u: MarkPriceMultiplexEvent) => void;
  /** Liquidation order events (`@forceOrder` stream). USD-M only. */
  onForceOrder?: (e: ForceOrderEvent) => void;
  /** Contract listing/delisting events (`!contractInfo`). */
  onContractInfo?: (e: ContractInfoEvent) => void;
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
  /** Stream per-symbol liquidation events (`@forceOrder`). USD-M only. Default false. */
  useForceOrder?: boolean;
  /** Stream ALL-symbol liquidation events (`!forceOrder@arr`). USD-M only. Default false. */
  useGlobalForceOrder?: boolean;
  /** Per-symbol mini ticker (`@miniTicker`). Default false. */
  useMiniTicker?: boolean;
  /** All-symbol ticker array (`!ticker@arr`). Default false. */
  useGlobalTicker?: boolean;
  /** All-symbol mini ticker array (`!miniTicker@arr`). Default false. */
  useGlobalMiniTicker?: boolean;
  /** All-symbol best bid/ask (`!bookTicker`). Default false. */
  useGlobalBookTicker?: boolean;
  /** Contract info stream (`!contractInfo`). USD-M only. Default false. */
  useContractInfo?: boolean;
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

const isPartialDepthStream = (stream: string | undefined): boolean => {
  return stream !== undefined && /@depth(5|10|20)(@|$)/.test(stream.toLowerCase());
}

export const buildStreamList = (opts: MultiplexOptions): string[] => {
  const out: string[] = [];
  for (const s of opts.symbols) {
    const lower = s.toLowerCase();
    for (const tf of opts.timeframes) out.push(`${lower}@kline_${tf}`);
    /** Last traded price (`c`) — USD-M needs this for LTP; mark stream alone is not last. */
    if (opts.product === 'spot' || isBinanceUsdmProduct(opts.product)) out.push(`${lower}@ticker`);
    if (opts.useBookTicker) out.push(`${lower}@bookTicker`);
    if (opts.depthLevels > 0) out.push(`${lower}@depth${opts.depthLevels}@${opts.depthSpeed}`);
    else out.push(`${lower}@depth@${opts.depthSpeed}`);
    if (opts.useAggTrade) out.push(`${lower}@aggTrade`);
    if (opts.useMarkPrice && isBinanceUsdmProduct(opts.product)) out.push(`${lower}@markPrice@1s`);
    if (opts.useForceOrder && isBinanceUsdmProduct(opts.product)) out.push(`${lower}@forceOrder`);
    if (opts.useMiniTicker) out.push(`${lower}@miniTicker`);
  }
  if (opts.useGlobalForceOrder && isBinanceUsdmProduct(opts.product)) out.push('!forceOrder@arr');
  if (opts.useGlobalTicker) out.push('!ticker@arr');
  if (opts.useGlobalMiniTicker) out.push('!miniTicker@arr');
  if (opts.useGlobalBookTicker) out.push('!bookTicker');
  if (opts.useContractInfo && isBinanceUsdmProduct(opts.product)) out.push('!contractInfo');
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
      return;
    }

    // Global array streams (!ticker@arr, !miniTicker@arr) wrap payload as an array.
    if (msg.stream && Array.isArray(msg.data)) {
      this.handleArrayStream(msg.stream as string, msg.data as Record<string, unknown>[]);
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
    if (evt === 'forceOrder') {
      this.dispatchForceOrder(data);
      return;
    }
    if (evt === '24hrMiniTicker') {
      this.dispatchMiniTicker(data);
      return;
    }
    if (evt === 'contractInfo') {
      this.dispatchContractInfo(data);
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
    const fundingRate = Number(data.r) || 0;
    this.cb.onMarkPrice?.({ symbol, markPrice, eventTime: Number(data.E ?? Date.now()), fundingRate });
  }

  private dispatch24hrTicker(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    const lastPrice = Number(data.c);
    const eventTime = Number(data.E ?? Date.now());
    if (!symbol || !Number.isFinite(lastPrice)) return;
    const priceChange = Number(data.p);
    const priceChangePercent = Number(data.P);
    const openPrice = Number(data.o);
    const highPrice = Number(data.h);
    const lowPrice = Number(data.l);
    const out: Ticker24hrEvent = { symbol, lastPrice, eventTime };
    if (Number.isFinite(priceChange)) out.priceChange = priceChange;
    if (Number.isFinite(priceChangePercent)) out.priceChangePercent = priceChangePercent;
    if (Number.isFinite(openPrice)) out.openPrice = openPrice;
    if (Number.isFinite(highPrice)) out.highPrice = highPrice;
    if (Number.isFinite(lowPrice)) out.lowPrice = lowPrice;
    this.cb.on24hrTicker?.(out);
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

  private dispatchForceOrder(data: Record<string, unknown>): void {
    const o = data.o as Record<string, unknown> | undefined;
    if (!o) return;
    this.cb.onForceOrder?.({
      symbol: String(o.s ?? '').toUpperCase(),
      side: String(o.S ?? ''),
      orderType: String(o.o ?? ''),
      timeInForce: String(o.f ?? ''),
      origQty: String(o.q ?? '0'),
      price: String(o.p ?? '0'),
      avgPrice: String(o.ap ?? '0'),
      orderStatus: String(o.X ?? ''),
      lastFilledQty: String(o.l ?? '0'),
      filledAccumulatedQty: String(o.z ?? '0'),
      tradeTime: Number(o.T ?? data.E ?? Date.now()),
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

  private handleArrayStream(stream: string, items: Record<string, unknown>[]): void {
    if (stream === '!ticker@arr') {
      for (const item of items) this.dispatch24hrTicker(item);
      return;
    }
    if (stream === '!miniTicker@arr') {
      for (const item of items) this.dispatchMiniTicker(item);
      return;
    }
  }

  private dispatchMiniTicker(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    const close = Number(data.c);
    if (!symbol || !Number.isFinite(close)) return;
    this.cb.onMiniTicker?.({
      symbol,
      close,
      open: Number(data.o) || 0,
      high: Number(data.h) || 0,
      low: Number(data.l) || 0,
      volume: Number(data.v) || 0,
      quoteVolume: Number(data.q) || 0,
      eventTime: Number(data.E ?? Date.now()),
    });
  }

  private dispatchContractInfo(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '').toUpperCase();
    if (!symbol) return;
    this.cb.onContractInfo?.({
      symbol,
      pair: String(data.ps ?? ''),
      contractType: String(data.ct ?? ''),
      deliveryDate: Number(data.dt ?? 0),
      onboardDate: Number(data.ot ?? 0),
      contractStatus: String(data.cs ?? ''),
      eventTime: Number(data.E ?? Date.now()),
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
    // C-7: jitter the 23h reconnect window by ±15% so two routes (and
    // independent bot instances) never close their sockets at the same
    // wall-clock minute. Without jitter, a fleet of bots reconnecting in
    // lockstep at 23:00 UTC produces a self-inflicted DoS against
    // fstream — Binance rate-limits the burst and the bots stay blind
    // for tens of seconds.
    const jitterPct = 0.15;
    const jitter = (Math.random() * 2 - 1) * jitterPct * this.reconnectAfterMs;
    const delayMs = Math.max(60_000, Math.floor(this.reconnectAfterMs + jitter));
    conn.rotateTimer = setTimeout(() => {
      conn.rotateTimer = null;
      this.forceReconnect(conn, 'rotate_24h');
    }, delayMs);
    if (typeof conn.rotateTimer.unref === 'function') conn.rotateTimer.unref();
  }

  private clearRotateTimer(conn: RouteConnection): void {
    if (conn.rotateTimer) {
      clearTimeout(conn.rotateTimer);
      conn.rotateTimer = null;
    }
  }
}
