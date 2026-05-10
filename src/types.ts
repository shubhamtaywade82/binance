/** OHLCV bar; `openTime` is exchange open time in ms (Binance kline t). */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime?: number;
}

export type TrendBias = 'LONG' | 'SHORT' | 'NONE';

export type Side = 'LONG' | 'SHORT';

export type CloseReason = 'TP' | 'SL' | 'REVERSAL' | 'LIQUIDATION' | 'MANUAL';

export interface Position {
  side: Side;
  entryPrice: number;
  quantity: number;
  takeProfit: number;
  stopLoss: number;
  openedAt: number;
  pair: string;
  notionalUsdt: number;
  marginInr: number;
}
