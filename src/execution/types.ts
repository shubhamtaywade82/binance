export type ExecutionMode = 'paper' | 'live';

export interface OrderRequest {
  pair: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  leverage: number;
  marginCurrency: string;
  referencePrice: number;
  takeProfit?: number;
  stopLoss?: number;
}

export interface Fill {
  price: number;
  quantity: number;
  feeUsdt: number;
  slippageUsdt: number;
  latencyMs: number;
  timestamp: number;
}

export interface OrderResult {
  ok: boolean;
  orderId: string;
  fill: Fill;
  positionId?: string;
  error?: string;
}

export type CloseReason = 'TP' | 'SL' | 'REVERSAL' | 'LIQUIDATION' | 'MANUAL';

export interface ClosedPosition {
  orderId: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  reason: CloseReason;
  grossUsdt: number;
  feesUsdt: number;
  fundingUsdt: number;
  netUsdt: number;
  openedAt: number;
  closedAt: number;
}

export interface ExecutionAdapter {
  name: ExecutionMode;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition>;
  onMark?(symbol: string, markPrice: number): void;
  setLeverage?(pair: string, lev: number): Promise<void>;
}
