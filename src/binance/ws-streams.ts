import { binanceWsBase } from '../config';
import type { AppConfig } from '../config';
import type { Candle } from '../types';
import type { DepthDeltaEvent } from './order-book-sync';
import { BinanceMultiplexWs } from './ws-multiplex';

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

/**
 * Single-symbol compatibility wrapper around the route-aware multiplex feed.
 * USD-M futures streams are split across Binance `/market` and `/public` endpoints.
 */
export class BinanceMarketWs {
  private mx: BinanceMultiplexWs | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly callbacks: BinanceStreamCallbacks,
  ) {}

  start(): void {
    if (this.mx) return;
    this.mx = new BinanceMultiplexWs(
      {
        baseWsUrl: binanceWsBase(this.cfg),
        symbols: [this.cfg.BINANCE_SYMBOL.trim().toUpperCase()],
        timeframes: [this.cfg.BINANCE_KLINE_INTERVAL],
        product: this.cfg.BINANCE_PRODUCT,
        useBookTicker: false,
        useAggTrade: true,
        depthLevels: 0,
        depthSpeed: '100ms',
        useMarkPrice: true,
        reconnectAfterHours: this.cfg.BINANCE_WS_RECONNECT_HOURS,
      },
      {
        onKline: (_symbol, _interval, candle, isFinal) => this.callbacks.onKline?.(candle, isFinal),
        onMarkPrice: (u) => this.callbacks.onMarkPrice?.(u),
        on24hrTicker: (u) => this.callbacks.onTickerLtp?.(u),
        onAggTrade: (u) =>
          this.callbacks.onAggTrade?.({
            symbol: u.symbol,
            price: u.price,
            quantity: u.qty,
            eventTime: u.ts,
            aggTradeId: u.aggTradeId,
          }),
        onDepthDiff: (d) => this.callbacks.onDepth?.(this.depthDiffToDelta(d)),
        onServerShutdown: () => this.callbacks.onServerShutdown?.(Date.now()),
        onOpen: () => this.callbacks.onOpen?.(),
        onError: (e) => this.callbacks.onError?.(e),
        onReconnect: (attempt) => this.callbacks.onReconnect?.(attempt),
      },
    );
    this.mx.start();
  }

  stop(): void {
    const mx = this.mx;
    this.mx = null;
    if (mx) void mx.stop();
  }

  private depthDiffToDelta(d: import('./orderbook').DepthDiff): DepthDeltaEvent {
    const rows = (side: typeof d.bids): [string, string][] =>
      side.map(([p, q]) => [String(p), String(q)]);
    return {
      U: d.U,
      u: d.u,
      bids: rows(d.bids),
      asks: rows(d.asks),
      ...(d.pu !== undefined ? { pu: d.pu } : {}),
      ...(d.E !== undefined ? { E: d.E } : {}),
      ...(d.s !== undefined ? { s: d.s } : {}),
    };
  }
}
