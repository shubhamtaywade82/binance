import WebSocket from 'ws';
import { binanceWsBase } from '../config';
import type { AppConfig } from '../config';
import type { Candle } from '../types';
import type { DepthDeltaEvent } from './order-book-sync';
import { normalizeBinanceKlineRow } from './rest-klines';

export interface MarkPriceUpdate {
  symbol: string;
  markPrice: number;
  eventTime: number;
}

/** Spot @ticker — last traded price (`c` in Binance payload). */
export interface TickerLtpUpdate {
  symbol: string;
  lastPrice: number;
  eventTime: number;
}

export interface AggTradeUpdate {
  symbol: string;
  price: number;
  quantity: number;
  eventTime: number;
  aggTradeId?: number;
}

export interface BinanceStreamCallbacks {
  onKline?: (candle: Candle, isFinal: boolean) => void;
  onMarkPrice?: (u: MarkPriceUpdate) => void;
  /** Spot LTP from 24hrTicker stream. */
  onTickerLtp?: (u: TickerLtpUpdate) => void;
  onAggTrade?: (u: AggTradeUpdate) => void;
  onDepth?: (ev: DepthDeltaEvent) => void;
  /** Server will disconnect in ~10m; reconnect early. */
  onServerShutdown?: (eventTimeMs: number) => void;
  onOpen?: () => void;
  onError?: (err: Error) => void;
  onReconnect?: (attempt: number) => void;
}

function streamPath(cfg: AppConfig, symbolLower: string, klineInterval: string): string {
  const klineStream = `${symbolLower}@kline_${klineInterval}`;
  const agg = `${symbolLower}@aggTrade`;
  const depth = `${symbolLower}@depth@100ms`;
  if (cfg.BINANCE_PRODUCT === 'spot') {
    const tickerStream = `${symbolLower}@ticker`;
    return `/stream?streams=${[klineStream, tickerStream, agg, depth].join('/')}`;
  }
  const markStream = `${symbolLower}@markPrice@1s`;
  return `/stream?streams=${[klineStream, markStream, agg, depth].join('/')}`;
}

function parseDepthPayload(data: Record<string, unknown>): DepthDeltaEvent | null {
  if (data.e !== 'depthUpdate') return null;
  const U = Number(data.U);
  const u = Number(data.u);
  if (!Number.isFinite(U) || !Number.isFinite(u)) return null;
  const rawB = data.b;
  const rawA = data.a;
  if (!Array.isArray(rawB) || !Array.isArray(rawA)) return null;
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (const row of rawB) {
    if (Array.isArray(row) && row.length >= 2) bids.push([String(row[0]), String(row[1])]);
  }
  for (const row of rawA) {
    if (Array.isArray(row) && row.length >= 2) asks.push([String(row[0]), String(row[1])]);
  }
  return { U, u, bids, asks };
}

/**
 * Binance WebSocket: kline, mark (USD-M) or ticker (spot), aggTrade, depth, with reconnect.
 * Honors `serverShutdown` with a fast reconnect. Stops reconnecting after `stop()`.
 */
export class BinanceMarketWs {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempt = 0;
  private quickReconnect = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly callbacks: BinanceStreamCallbacks,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    this.quickReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    const base = binanceWsBase(this.cfg).replace(/\/$/, '');
    const sym = this.cfg.BINANCE_SYMBOL.toLowerCase();
    const path = streamPath(this.cfg, sym, this.cfg.BINANCE_KLINE_INTERVAL);
    const url = `${base}${path}`;

    const socket = new WebSocket(url);
    this.ws = socket;

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const text = raw.toString();
        const msg = JSON.parse(text) as Record<string, unknown>;
        this.handleMessage(msg);
      } catch (e) {
        this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });

    socket.on('open', () => {
      this.attempt = 0;
      this.callbacks.onOpen?.();
    });

    socket.on('close', () => {
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });

    socket.on('error', (err) => {
      this.callbacks.onError?.(err);
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.e === 'serverShutdown') {
      const t = Number(msg.E);
      this.callbacks.onServerShutdown?.(Number.isFinite(t) ? t : Date.now());
      this.requestQuickReconnectAndClose();
      return;
    }

    if (msg.stream && msg.data) {
      const data = msg.data as Record<string, unknown>;
      if (data.e === 'serverShutdown') {
        const t = Number(data.E);
        this.callbacks.onServerShutdown?.(Number.isFinite(t) ? t : Date.now());
        this.requestQuickReconnectAndClose();
        return;
      }
      if (data.e === 'kline') {
        this.dispatchKline(data as Record<string, unknown>);
      } else if (data.e === 'markPriceUpdate') {
        this.dispatchMark(data);
      } else if (data.e === '24hrTicker') {
        this.dispatchTickerLtp(data);
      } else if (data.e === 'aggTrade') {
        this.dispatchAggTrade(data);
      } else if (data.e === 'depthUpdate') {
        const d = parseDepthPayload(data);
        if (d) this.callbacks.onDepth?.(d);
      }
      return;
    }

    if (msg.e === 'kline') {
      this.dispatchKline(msg as Record<string, unknown>);
    } else if (msg.e === '24hrTicker') {
      this.dispatchTickerLtp(msg as Record<string, unknown>);
    } else if (msg.e === 'aggTrade') {
      this.dispatchAggTrade(msg as Record<string, unknown>);
    } else if (msg.e === 'depthUpdate') {
      const d = parseDepthPayload(msg);
      if (d) this.callbacks.onDepth?.(d);
    }
  }

  private requestQuickReconnectAndClose(): void {
    if (this.closed) return;
    this.quickReconnect = true;
    const s = this.ws;
    if (s) {
      s.removeAllListeners('close');
      s.once('close', () => {
        this.ws = null;
        if (!this.closed) this.scheduleReconnect();
      });
      s.close();
    }
  }

  private dispatchKline(wrapper: Record<string, unknown>): void {
    const k = wrapper.k as Record<string, unknown> | undefined;
    if (!k) return;
    const row = [k.t, k.o, k.h, k.l, k.c, k.v, k.T];
    const candle = normalizeBinanceKlineRow(row);
    if (!candle) return;
    const isFinal = Boolean(k.x);
    this.callbacks.onKline?.(candle, isFinal);
  }

  private dispatchMark(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '');
    const markPrice = Number(data.p);
    const eventTime = Number(data.E ?? data.T ?? Date.now());
    if (!symbol || !Number.isFinite(markPrice)) return;
    this.callbacks.onMarkPrice?.({ symbol, markPrice, eventTime });
  }

  private dispatchTickerLtp(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '');
    const lastPrice = Number(data.c);
    const eventTime = Number(data.E ?? Date.now());
    if (!symbol || !Number.isFinite(lastPrice)) return;
    this.callbacks.onTickerLtp?.({ symbol, lastPrice, eventTime });
  }

  private dispatchAggTrade(data: Record<string, unknown>): void {
    const symbol = String(data.s ?? '');
    const price = Number(data.p);
    const quantity = Number(data.q);
    const eventTime = Number(data.E ?? Date.now());
    const aggTradeId = data.a !== undefined ? Number(data.a) : undefined;
    if (!symbol || !Number.isFinite(price)) return;
    this.callbacks.onAggTrade?.({
      symbol,
      price,
      quantity: Number.isFinite(quantity) ? quantity : 0,
      eventTime,
      aggTradeId: Number.isFinite(aggTradeId) ? aggTradeId : undefined,
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.attempt += 1;
    const delayMs = this.quickReconnect
      ? 0
      : Math.min(60_000, 500 * 2 ** Math.min(this.attempt, 10));
    this.quickReconnect = false;
    this.callbacks.onReconnect?.(this.attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}
