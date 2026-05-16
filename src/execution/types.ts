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
  /** Optional strategy tier ('scalp' | 'swing') for persistence/dashboard tagging. */
  tier?: string;
  /** Optional reason for entry (e.g. 'ENTRY', 'PYRAMID'). */
  reason?: string;
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

export type CloseReason =
  | 'TP'
  | 'SL'
  | 'REVERSAL'
  | 'LIQUIDATION'
  | 'MANUAL'
  | 'PARTIAL_TP'
  | 'TRAIL'
  | 'SMC_EXIT'
  | 'TIME_STOP'
  | 'FUNDING_KICK';

export interface TradeAttribution {
  entrySignal?: string;
  smcZone?: string;
  htfBias?: string;
  ltfBias?: string;
  confidence?: number;
}

export interface ClosedPosition {
  orderId: string;
  side: 'LONG' | 'SHORT';
  /** Cross margin / isolated leverage at entry (1 = spot-style). */
  leverage: number;
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
  attribution?: TradeAttribution;
}

export interface ExecutionAdapter {
  name: ExecutionMode;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  closePosition(orderId: string, reason: CloseReason, quantity?: number): Promise<ClosedPosition>;
  onMark?(symbol: string, markPrice: number): void;
  setLeverage?(pair: string, lev: number): Promise<void>;
}
