import type { BinanceRestClient } from './rest-client';

// ─── Listen Key ────────────────────────────────────────────────────────────

export async function createListenKey(client: BinanceRestClient): Promise<string> {
  const res = await client.signedPost<{ listenKey: string }>('/fapi/v1/listenKey');
  return res.listenKey;
}

export async function keepAliveListenKey(client: BinanceRestClient, listenKey: string): Promise<void> {
  await client.signedPut('/fapi/v1/listenKey', { listenKey });
}

export async function deleteListenKey(client: BinanceRestClient, listenKey: string): Promise<void> {
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

export async function getAccountInfo(client: BinanceRestClient): Promise<FuturesAccount> {
  return client.signedGet<FuturesAccount>('/fapi/v2/account');
}

export async function getBalances(client: BinanceRestClient): Promise<FuturesBalance[]> {
  return client.signedGet<FuturesBalance[]>('/fapi/v2/balance');
}

export async function getPositionRisk(
  client: BinanceRestClient,
  symbol?: string,
): Promise<FuturesPositionRisk[]> {
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

export async function setLeverage(
  client: BinanceRestClient,
  symbol: string,
  leverage: number,
): Promise<LeverageResult> {
  return client.signedPost<LeverageResult>('/fapi/v1/leverage', {
    symbol: symbol.toUpperCase(),
    leverage,
  });
}

export type MarginType = 'ISOLATED' | 'CROSSED';

export async function setMarginType(
  client: BinanceRestClient,
  symbol: string,
  marginType: MarginType,
): Promise<void> {
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

export async function placeOrder(
  client: BinanceRestClient,
  params: PlaceOrderParams,
): Promise<OrderResult> {
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

export async function cancelOrder(
  client: BinanceRestClient,
  symbol: string,
  orderId: number,
): Promise<OrderResult> {
  return client.signedDelete<OrderResult>('/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    orderId,
  });
}

export async function cancelAllOrders(
  client: BinanceRestClient,
  symbol: string,
): Promise<{ code: number; msg: string }> {
  return client.signedDelete('/fapi/v1/allOpenOrders', { symbol: symbol.toUpperCase() });
}

export async function getOpenOrders(
  client: BinanceRestClient,
  symbol?: string,
): Promise<OrderResult[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol.toUpperCase();
  return client.signedGet<OrderResult[]>('/fapi/v1/openOrders', params);
}

export async function getOrder(
  client: BinanceRestClient,
  symbol: string,
  orderId: number,
): Promise<OrderResult> {
  return client.signedGet<OrderResult>('/fapi/v1/order', {
    symbol: symbol.toUpperCase(),
    orderId,
  });
}

// ─── Batch Orders ──────────────────────────────────────────────────────────

export async function placeBatchOrders(
  client: BinanceRestClient,
  orders: PlaceOrderParams[],
): Promise<OrderResult[]> {
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

export async function placeAlgoOrder(
  client: BinanceRestClient,
  params: AlgoOrderParams,
): Promise<AlgoOrderResult> {
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

export async function cancelAlgoOrder(
  client: BinanceRestClient,
  symbol: string,
  strategyId: number,
): Promise<AlgoOrderResult> {
  return client.signedDelete<AlgoOrderResult>('/fapi/v1/algoOrder', {
    symbol: symbol.toUpperCase(),
    strategyId,
  });
}

export async function cancelAllAlgoOrders(
  client: BinanceRestClient,
  symbol: string,
): Promise<{ code: number; msg: string }> {
  return client.signedDelete('/fapi/v1/algoOpenOrders', { symbol: symbol.toUpperCase() });
}

export async function getOpenAlgoOrders(
  client: BinanceRestClient,
  symbol?: string,
): Promise<AlgoOrderResult[]> {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol.toUpperCase();
  const res = await client.signedGet<AlgoOrderListResponse>('/fapi/v1/openAlgoOrders', params);
  return res.orders ?? [];
}

// ─── Server Time ───────────────────────────────────────────────────────────

export async function getServerTime(client: BinanceRestClient): Promise<number> {
  const res = await client.publicGet<{ serverTime: number }>('/fapi/v1/time');
  return res.serverTime;
}
