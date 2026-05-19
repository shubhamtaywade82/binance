import type {
  Candle,
  DepthDelta,
  OrderBookSnapshot,
  Trade,
  BookTicker,
  SymbolRef,
  InstrumentMeta,
} from './types';

export type Unsub = () => void;

/**
 * Implemented by every provider microservice. The adapter-core RedisAdapter
 * base class wires these methods to Redis topics — implementors only worry
 * about talking to the upstream exchange.
 */
export interface MarketDataProvider {
  /** Stable identifier — used as topic prefix and URL scheme. */
  readonly id: string;

  /** Human-readable name shown in the provider settings UI. */
  readonly displayName: string;

  /** Initialize REST clients, WS pools, instrument master, etc. */
  init(): Promise<void>;

  /** Cleanup on shutdown. */
  shutdown(): Promise<void>;

  // ── Discovery ─────────────────────────────────────────────────────────
  searchSymbols(query: string, limit?: number): Promise<SymbolRef[]>;
  listSymbols(filter?: { segment?: string }): Promise<InstrumentMeta[]>;
  getInstrumentMeta(symbol: string): Promise<InstrumentMeta | null>;

  // ── Snapshots ─────────────────────────────────────────────────────────
  getCandles(symbol: string, interval: string, opts?: { limit?: number; startTime?: number; endTime?: number }): Promise<Candle[]>;
  getOrderBook(symbol: string, limit?: number): Promise<OrderBookSnapshot | null>;

  // ── Live streams (push-based) ─────────────────────────────────────────
  streamCandles(symbol: string, interval: string, onCandle: (c: Candle, isFinal: boolean) => void): Unsub;
  streamDepth(symbol: string, onDelta: (d: DepthDelta) => void): Unsub;
  streamTrades(symbol: string, onTrade: (t: Trade) => void): Unsub;
  streamBookTicker(symbol: string, onTicker: (t: BookTicker) => void): Unsub;
}
