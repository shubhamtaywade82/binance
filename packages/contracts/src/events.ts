import { z } from 'zod';

export const DomainEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  ts: z.number(),
  source: z.string(),
  symbol: z.string().optional(),
  payload: z.unknown(),
});

export type DomainEvent<T = unknown> = Omit<z.infer<typeof DomainEventSchema>, 'payload'> & {
  payload: T;
};

// specific event payloads

export const KlineClosedPayloadSchema = z.object({
  openTime: z.number(),
  closeTime: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  quoteVolume: z.number(),
  trades: z.number(),
});
export type KlineClosedPayload = z.infer<typeof KlineClosedPayloadSchema>;

export const TradePayloadSchema = z.object({
  tradeId: z.number().optional(),
  price: z.number(),
  quantity: z.number(),
  isBuyerMaker: z.boolean(),
  timestamp: z.number(),
});
export type TradePayload = z.infer<typeof TradePayloadSchema>;

export const DepthDeltaPayloadSchema = z.object({
  firstUpdateId: z.number(),
  finalUpdateId: z.number(),
  bids: z.array(z.tuple([z.number(), z.number()])),
  asks: z.array(z.tuple([z.number(), z.number()])),
  timestamp: z.number(),
});
export type DepthDeltaPayload = z.infer<typeof DepthDeltaPayloadSchema>;

export const BookTickerPayloadSchema = z.object({
  updateId: z.number(),
  bestBidPrice: z.number(),
  bestBidQty: z.number(),
  bestAskPrice: z.number(),
  bestAskQty: z.number(),
  timestamp: z.number(),
});
export type BookTickerPayload = z.infer<typeof BookTickerPayloadSchema>;

export const SignalPayloadSchema = z.object({
  strategyId: z.string(),
  signal: z.enum(['LONG', 'SHORT', 'FLAT']),
  confidence: z.number(),
  metadata: z.record(z.unknown()).optional(),
});
export type SignalPayload = z.infer<typeof SignalPayloadSchema>;

export const OrderSubmittedPayloadSchema = z.object({
  orderId: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.string(),
  quantity: z.number(),
  price: z.number().optional(),
});
export type OrderSubmittedPayload = z.infer<typeof OrderSubmittedPayloadSchema>;
