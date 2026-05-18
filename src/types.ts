/** OHLCV bar; `openTime` is exchange open time in ms (Binance kline t). */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime?: number;
  /**
   * C-10: sealed-bar invariant. `true` when the bar is final (Binance kline
   * `x === true` or historical REST result). Once sealed, MultiTimeframeStore
   * refuses to overwrite the bar with a later non-final update, and
   * lookback-sensitive indicators (e.g. SMC FVG fill detection) only operate
   * on sealed neighbours so the live tip can't poison a backward-looking
   * computation. Unset / false on still-forming live bars.
   */
  sealed?: boolean;
}

export type TrendBias = 'LONG' | 'SHORT' | 'NONE';

export type Side = 'LONG' | 'SHORT';

export type CloseReason = 'TP' | 'SL' | 'REVERSAL' | 'LIQUIDATION' | 'MANUAL' | 'PARTIAL_TP' | 'TRAIL' | 'SMC_EXIT';

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
  initialStopDistance?: number;
}

export interface DashboardPosition {
  orderId: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  leverage?: number;
  openedAt: number;
  unrealizedUsdt?: number;
  mode?: 'paper' | 'live';
  marginUsdt?: number;
  liqPrice?: number;
}
