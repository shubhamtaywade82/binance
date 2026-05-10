import WebSocket from 'ws';
import { binanceWsBase } from '../config';
import type { AppConfig } from '../config';
import type { Candle } from '../types';
import { normalizeBinanceKlineRow } from './rest-klines';

export interface MarkPriceUpdate {
  symbol: string;
  markPrice: number;
  eventTime: number;
}

export interface BinanceStreamCallbacks {
  onKline?: (candle: Candle, isFinal: boolean) => void;
  onMarkPrice?: (u: MarkPriceUpdate) => void;
  onError?: (err: Error) => void;
  onReconnect?: (attempt: number) => void;
}

function streamPath(cfg: AppConfig, symbolLower: string, klineInterval: string): string {
  const klineStream = `${symbolLower}@kline_${klineInterval}`;
  const markStream = `${symbolLower}@markPrice@1s`;
  if (cfg.BINANCE_PRODUCT === 'spot') {
    return `/ws/${klineStream}`;
  }
  const streams = `${klineStream}/${markStream}`;
  return `/stream?streams=${streams}`;
}

/**
 * Binance WebSocket: kline (+ USD-M mark price when product is usdm).
 * Reconnect with exponential backoff (cap 60s).
 */
export class BinanceMarketWs {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private attempt = 0;

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
    if (this.cfg.BINANCE_PRODUCT === 'usdm' && msg.stream && msg.data) {
      const data = msg.data as Record<string, unknown>;
      if (data.e === 'kline') {
        this.dispatchKline(data as Record<string, unknown>);
      } else if (data.e === 'markPriceUpdate') {
        this.dispatchMark(data);
      }
      return;
    }

    if (msg.e === 'kline') {
      this.dispatchKline(msg as Record<string, unknown>);
    }
  }

  private dispatchKline(wrapper: Record<string, unknown>): void {
    const k = wrapper.k as Record<string, unknown> | undefined;
    if (!k) return;
    const row = [
      k.t,
      k.o,
      k.h,
      k.l,
      k.c,
      k.v,
      k.T,
    ];
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

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.attempt += 1;
    const delayMs = Math.min(60_000, 500 * 2 ** Math.min(this.attempt, 10));
    this.callbacks.onReconnect?.(this.attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}
