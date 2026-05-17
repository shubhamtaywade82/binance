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
  /**
   * Caller-supplied idempotency key (e.g. event-bus correlation id). When set,
   * adapters MUST use it to dedupe duplicate submissions and to derive the
   * exchange-side `client_order_id`. Two `placeOrder` calls with the same key
   * within the adapter's idempotency window return the cached result instead
   * of placing a second exchange order.
   */
  idempotencyKey?: string;
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
  /** Underlying symbol (e.g. SOLUSDT) — required by event-bus listeners. */
  symbol?: string;
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

export interface WalletState {
  balanceUsdt: number;
  availableUsdt: number;
  usedMarginUsdt: number;
  unrealizedPnlUsdt: number;
  realizedPnlUsdt: number;
  equityUsdt: number;
  updatedAt: number;
}

export interface ExecutionAdapter {
  name: ExecutionMode;
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  closePosition(orderId: string, reason: CloseReason, quantity?: number): Promise<ClosedPosition>;
  onMark?(symbol: string, markPrice: number): void;
  setLeverage?(pair: string, lev: number): Promise<void>;
  getWalletState?(): WalletState | Promise<WalletState>;
  getOpenPositions?(): any[] | Promise<any[]>;
  setOnTradeClose?(cb: (trade: ClosedPosition) => void): void;
}

