import { z } from 'zod';

export const CandleSchema = z.object({
  openTime: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  closeTime: z.number().optional(),
  sealed: z.boolean().optional(),
});
export type Candle = z.infer<typeof CandleSchema>;

export const TradeSchema = z.object({
  price: z.number(),
  qty: z.number(),
  ts: z.number(),
  /** True when the buyer was the market maker (i.e. trade was sell-aggressor). */
  makerSide: z.boolean(),
  tradeId: z.number().optional(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const PriceLevelSchema = z.tuple([z.number(), z.number()]);
export type PriceLevel = z.infer<typeof PriceLevelSchema>;

export const OrderBookSnapshotSchema = z.object({
  lastUpdateId: z.number(),
  bids: z.array(PriceLevelSchema),
  asks: z.array(PriceLevelSchema),
  ts: z.number(),
});
export type OrderBookSnapshot = z.infer<typeof OrderBookSnapshotSchema>;

export const DepthDeltaSchema = z.object({
  firstUpdateId: z.number(),
  finalUpdateId: z.number(),
  /** Previous final updateId, for Binance USD-M continuity check. Optional. */
  prevUpdateId: z.number().optional(),
  bids: z.array(PriceLevelSchema),
  asks: z.array(PriceLevelSchema),
  ts: z.number(),
  /**
   * True when bids/asks are a full top-N replacement rather than an incremental delta.
   * Set by providers (e.g. Dhan) whose depth stream emits only snapshots.
   */
  replacement: z.boolean().optional(),
});
export type DepthDelta = z.infer<typeof DepthDeltaSchema>;

export const BookTickerSchema = z.object({
  bestBidPrice: z.number(),
  bestBidQty: z.number(),
  bestAskPrice: z.number(),
  bestAskQty: z.number(),
  ts: z.number(),
});
export type BookTicker = z.infer<typeof BookTickerSchema>;

export const InstrumentPrecisionSchema = z.object({
  tickSize: z.number(),
  stepSize: z.number(),
  minQty: z.number(),
});
export type InstrumentPrecision = z.infer<typeof InstrumentPrecisionSchema>;

/** Lightweight reference used in search results. */
export const SymbolRefSchema = z.object({
  provider: z.string(),
  symbol: z.string(),
  /** Human-readable label, e.g. "BTC-USDT Perp", "Reliance Industries". */
  label: z.string().optional(),
  /** e.g. "spot" | "futures" | "equity" | "option". */
  segment: z.string().optional(),
});
export type SymbolRef = z.infer<typeof SymbolRefSchema>;

export const InstrumentMetaSchema = SymbolRefSchema.extend({
  precision: InstrumentPrecisionSchema.optional(),
  /** Exchange-native identifier (e.g. Dhan security id). */
  exchangeId: z.string().optional(),
  contractType: z.string().optional(),
  expiry: z.number().optional(),
  /** Default interval suggestions, in provider syntax (e.g. "1m", "5m", "1D"). */
  intervals: z.array(z.string()).optional(),
});
export type InstrumentMeta = z.infer<typeof InstrumentMetaSchema>;

/** Channels a client can subscribe to via the gateway. */
export type Channel = 'candle' | 'depth' | 'trade' | 'ticker';

/** Envelope published on data topics. */
export interface DataEnvelope<T = unknown> {
  provider: string;
  symbol: string;
  channel: Channel;
  /** Optional sub-channel key, e.g. interval for candles. */
  key?: string;
  /** "snapshot" sent on first subscribe, "update" thereafter. */
  kind: 'snapshot' | 'update';
  ts: number;
  data: T;
}
