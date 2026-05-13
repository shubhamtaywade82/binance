import type { BinanceRestClient } from './rest-client';

// ─── Listen Key ────────────────────────────────────────────────────────────

export const createListenKey = async (client: BinanceRestClient): Promise<string> => {
  const res = await client.signedPost<{ listenKey: string }>('/fapi/v1/listenKey');
  return res.listenKey;
}

export const keepAliveListenKey = async (client: BinanceRestClient, listenKey: string): Promise<void> => {
  await client.signedPut('/fapi/v1/listenKey', { listenKey });
}

export const deleteListenKey = async (client: BinanceRestClient, listenKey: string): Promise<void> => {
  await client.signedDelete('/fapi/v1/listenKey', { listenKey });
}

// ─── Account & Position ────────────────────────────────────────────────────

export interface FuturesBalance {
  asset: string;
  balance: string;
  crossWalletBalance: string;
  availableBalance: string;
  updateTime: number;
}

export interface FuturesAccountAsset {
  asset: string;
  walletBalance: string;
  unrealizedProfit: string;
  marginBalance: string;
  availableBalance: string;
}

export interface FuturesAccount {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  assets: FuturesAccountAsset[];
  positions: FuturesPositionRisk[];
}

export interface FuturesPositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  marginType: string;
  isolatedMargin: string;
  isAutoAddMargin: string;
  positionSide: string;
  notional: string;
  isolatedWallet: string;
  updateTime: number;
}

export const getAccountInfo = async (client: BinanceRestClient): Promise<FuturesAccount> => {
  return client.signedGet<FuturesAccount>('/fapi/v2/account');
}

export const getBalances = async (client: BinanceRestClient): Promise<FuturesBalance[]> => {
  return client.signedGet<FuturesBalance[]>('/fapi/v2/balance');
}

export const getPositionRisk = async (client: BinanceRestClient, symbol?: string): Promise<FuturesPositionRisk[]> => {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol.toUpperCase();
  return client.signedGet<FuturesPositionRisk[]>('/fapi/v2/positionRisk', params);
}

// ─── Leverage & Margin ─────────────────────────────────────────────────────

export interface LeverageResult {
  symbol: string;
  leverage: number;
  maxNotionalValue: string;
}

export const setLeverage = async (client: BinanceRestClient, symbol: string, leverage: number): Promise<LeverageResult> => {
  return client.signedPost<LeverageResult>('/fapi/v1/leverage', {
    symbol: symbol.toUpperCase(),
    leverage,
  });
}

export type MarginType = 'ISOLATED' | 'CROSSED';

export const setMarginType = async (client: BinanceRestClient, symbol: string, marginType: MarginType): Promise<void> => {
  try {
    await client.signedPost('/fapi/v1/marginType', {
      symbol: symbol.toUpperCase(),
      marginType,
    });
  } catch (e) {
    // Code -4046 = margin type already set — not an error.
    const err = e as { binanceCode?: number };
    if (err.binanceCode === -4046) return;
    throw e;
  }
}

// ─── Orders ────────────────────────────────────────────────────────────────

export type OrderSide = 'BUY' | 'SELL';
export type OrderType =
  | 'MARKET'
  | 'LIMIT'
  | 'STOP'
  | 'STOP_MARKET'
  | 'TAKE_PROFIT'
  | 'TAKE_PROFIT_MARKET'
  | 'TRAILING_STOP_MARKET';

export type TimeInForce = 'GTC' | 'IOC' | 'FOK' | 'GTX' | 'GTE_GTC';
export type WorkingType = 'MARK_PRICE' | 'CONTRACT_PRICE';
export type PositionSide = 'BOTH' | 'LONG' | 'SHORT';
export type OrderResponseType = 'ACK' | 'RESULT';

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity?: number;
  price?: number;
  stopPrice?: number;
  /** Trailing stop callback rate (%). */
  callbackRate?: number;
  timeInForce?: TimeInForce;
  workingType?: WorkingType;
  positionSide?: PositionSide;
  /** true = reduce-only (close side). */
  reduceOnly?: boolean;
  /** true = close entire position (overrides quantity). */
  closePosition?: boolean;
  newOrderRespType?: OrderResponseType;
  newClientOrderId?: string;
  activationPrice?: number;
}

export interface OrderResult {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  timeInForce: string;
  type: string;
  side: string;
  stopPrice: string;
  workingType: string;
  origType: string;
  positionSide: string;
  reduceOnly: boolean;
  closePosition: boolean;
  updateTime: number;
  time?: number;
  activatePrice?: string;
  priceRate?: string;
}

export const placeOrder = async (client: BinanceRestClient, params: PlaceOrderParams): Promise<OrderResult> => {
  const body: Record<string, string | number | boolean> = {
    symbol: params.symbol.toUpperCase(),
    side: params.side,
    type: params.type,
    newOrderRespType: params.newOrderRespType ?? 'RESULT',
  };

  if (params.quantity !== undefined) body.quantity = params.quantity;
  if (params.price !== undefined) body.price = params.price;
  if (params.stopPrice !== undefined) body.stopPrice = params.stopPrice;
  if (params.callbackRate !== undefined) body.callbackRate = params.callbackRate;
  if (params.timeInForce !== undefined) body.timeInForce = params.timeInForce;
  if (params.workingType !== undefined) body.workingType = params.workingType;
  if (params.positionSide !== undefined) body.positionSide = params.positionSide;
  if (params.reduceOnly !== undefined) body.reduceOnly = params.reduceOnly;
  if (params.closePosition !== undefined) body.closePosition = params.closePosition;
  if (params.newClientOrderId !== undefined) body.newClientOrderId = params.newClientOrderId;
  if (params.activationPrice !== undefined) body.activationPrice = params.activationPrice;

  return client.signedPost<OrderResult>('/fapi/v1/order', body);
}

export const cancelOrder = async (client: BinanceRestClient, symbol: string, orderId: number): Promise<OrderResult> => {
  return client.signedDelete<OrderResult>('/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    orderId,
  });
}

export const cancelAllOrders = async (client: BinanceRestClient, symbol: string): Promise<{ code: number; msg: string }> => {
  return client.signedDelete('/fapi/v1/allOpenOrders', { symbol: symbol.toUpperCase() });
}

export const getOpenOrders = async (client: BinanceRestClient, symbol?: string): Promise<OrderResult[]> => {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol.toUpperCase();
  return client.signedGet<OrderResult[]>('/fapi/v1/openOrders', params);
}

export const getOrder = async (client: BinanceRestClient, symbol: string, orderId: number): Promise<OrderResult> => {
  return client.signedGet<OrderResult>('/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    orderId,
  });
}

// ─── Batch Orders ──────────────────────────────────────────────────────────

export const placeBatchOrders = async (client: BinanceRestClient, orders: PlaceOrderParams[]): Promise<OrderResult[]> => {
  const batchOrders = orders.map((p) => {
    const o: Record<string, string | number | boolean> = {
      symbol: p.symbol.toUpperCase(),
      side: p.side,
      type: p.type,
      newOrderRespType: p.newOrderRespType ?? 'RESULT',
    };
    if (p.quantity !== undefined) o.quantity = p.quantity;
    if (p.price !== undefined) o.price = p.price;
    if (p.stopPrice !== undefined) o.stopPrice = p.stopPrice;
    if (p.timeInForce !== undefined) o.timeInForce = p.timeInForce;
    if (p.workingType !== undefined) o.workingType = p.workingType;
    if (p.reduceOnly !== undefined) o.reduceOnly = p.reduceOnly;
    if (p.closePosition !== undefined) o.closePosition = p.closePosition;
    return o;
  });
  return client.signedPost<OrderResult[]>('/fapi/v1/batchOrders', {
    batchOrders: JSON.stringify(batchOrders),
  });
}

// ─── Algo Orders (Dec 2025 migration: STOP_MARKET / TAKE_PROFIT_MARKET / TRAILING) ──────────

export type AlgoOrderType = 'STOP_MARKET' | 'TAKE_PROFIT_MARKET' | 'TRAILING_STOP_MARKET';

export interface AlgoOrderParams {
  symbol: string;
  side: OrderSide;
  type: AlgoOrderType;
  quantity?: number;
  stopPrice?: number;
  /** Trailing stop callback rate in %. Required for TRAILING_STOP_MARKET. */
  callbackRate?: number;
  /** Trailing stop activation price. */
  activationPrice?: number;
  closePosition?: boolean;
  reduceOnly?: boolean;
  workingType?: WorkingType;
  positionSide?: PositionSide;
  /** GTE_GTC = auto-cancel when position is gone. Recommended for TP/SL algo orders. */
  timeInForce?: TimeInForce;
  newClientStrategyId?: string;
}

export interface AlgoOrderResult {
  strategyId: number;
  clientStrategyId: string;
  symbol: string;
  side: string;
  positionSide: string;
  type: string;
  origQty: string;
  price: string;
  stopPrice: string;
  workingType: string;
  reduceOnly: boolean;
  closePosition: boolean;
  timeInForce: string;
  bookTime: number;
  updateTime: number;
}

interface AlgoOrderListResponse {
  total: number;
  orders: AlgoOrderResult[];
}

export const placeAlgoOrder = async (client: BinanceRestClient, params: AlgoOrderParams): Promise<AlgoOrderResult> => {
  const body: Record<string, string | number | boolean> = {
    symbol: params.symbol.toUpperCase(),
    side: params.side,
    type: params.type,
  };
  if (params.quantity !== undefined) body.quantity = params.quantity;
  if (params.stopPrice !== undefined) body.stopPrice = params.stopPrice;
  if (params.callbackRate !== undefined) body.callbackRate = params.callbackRate;
  if (params.activationPrice !== undefined) body.activationPrice = params.activationPrice;
  if (params.closePosition !== undefined) body.closePosition = params.closePosition;
  if (params.reduceOnly !== undefined) body.reduceOnly = params.reduceOnly;
  if (params.workingType !== undefined) body.workingType = params.workingType;
  if (params.positionSide !== undefined) body.positionSide = params.positionSide;
  if (params.timeInForce !== undefined) body.timeInForce = params.timeInForce;
  if (params.newClientStrategyId !== undefined) body.newClientStrategyId = params.newClientStrategyId;
  return client.signedPost<AlgoOrderResult>('/fapi/v1/algoOrder', body);
}

export const cancelAlgoOrder = async (client: BinanceRestClient, symbol: string, strategyId: number): Promise<AlgoOrderResult> => {
  return client.signedDelete<AlgoOrderResult>('/fapi/v1/algoOrder', {
    symbol: symbol.toUpperCase(),
    strategyId,
  });
}

export const cancelAllAlgoOrders = async (client: BinanceRestClient, symbol: string): Promise<{ code: number; msg: string }> => {
  return client.signedDelete('/fapi/v1/algoOpenOrders', { symbol: symbol.toUpperCase() });
}

export const getOpenAlgoOrders = async (client: BinanceRestClient, symbol?: string): Promise<AlgoOrderResult[]> => {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol.toUpperCase();
  const res = await client.signedGet<AlgoOrderListResponse>('/fapi/v1/openAlgoOrders', params);
  return res.orders ?? [];
}

// ─── Position mode (hedge vs one-way) ─────────────────────────────────────

export interface PositionSideDualResponse {
  dualSidePosition: boolean;
}

export const getPositionSideDual = async (client: BinanceRestClient): Promise<PositionSideDualResponse> => {
  return client.signedGet<PositionSideDualResponse>('/fapi/v1/positionSide/dual');
}

// ─── User trades (fills / reconciliation) ───────────────────────────────────

export interface UserTradeRow {
  buyer: boolean;
  commission: string;
  commissionAsset: string;
  id: number;
  maker: boolean;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  realizedPnl: string;
  side: string;
  positionSide: string;
  symbol: string;
  time: number;
}

export const getUserTrades = async (
  client: BinanceRestClient,
  params: {
    symbol: string;
    orderId?: number;
    startTime?: number;
    endTime?: number;
    fromId?: number;
    limit?: number;
  },
): Promise<UserTradeRow[]> => {
  const q: Record<string, string | number> = { symbol: params.symbol.toUpperCase() };
  if (params.orderId !== undefined) q.orderId = params.orderId;
  if (params.startTime !== undefined) q.startTime = params.startTime;
  if (params.endTime !== undefined) q.endTime = params.endTime;
  if (params.fromId !== undefined) q.fromId = params.fromId;
  if (params.limit !== undefined) q.limit = params.limit;
  return client.signedGet<UserTradeRow[]>('/fapi/v1/userTrades', q);
}

// ─── Order rate limits (REST quota snapshot) ──────────────────────────────

export interface OrderRateLimitRow {
  rateLimitType: string;
  interval: string;
  intervalNum: number;
  limit: number;
  count: number;
}

export const getOrderRateLimit = async (client: BinanceRestClient): Promise<OrderRateLimitRow[]> => {
  return client.signedGet<OrderRateLimitRow[]>('/fapi/v1/rateLimit/order');
}

// ─── Dead-man auto-cancel all (countdown) ─────────────────────────────────

export interface CountdownCancelAllResponse {
  symbol?: string;
  countdownTime: string;
}

/**
 * Reset the exchange-side dead-man timer. Each call extends the countdown.
 * `countdownTime` in ms; use `0` to cancel the timer without closing orders.
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Auto-Cancel-All-Open-Orders
 */
export const setCountdownCancelAll = async (
  client: BinanceRestClient,
  params: { symbol?: string; countdownTime: number },
): Promise<CountdownCancelAllResponse> => {
  const body: Record<string, string | number> = { countdownTime: params.countdownTime };
  if (params.symbol) body.symbol = params.symbol.toUpperCase();
  return client.signedPost<CountdownCancelAllResponse>('/fapi/v1/countdownCancelAll', body);
}

// ─── Server Time ───────────────────────────────────────────────────────────

export const getServerTime = async (client: BinanceRestClient): Promise<number> => {
  const res = await client.publicGet<{ serverTime: number }>('/fapi/v1/time');
  return res.serverTime;
}
