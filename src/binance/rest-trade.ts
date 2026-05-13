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

// ─── Modify Order ────────────────────────────────────────────────────────

export interface ModifyOrderParams {
  symbol: string;
  orderId: number;
  side: OrderSide;
  quantity: number;
  price: number;
  /** Defaults to MARK_PRICE for futures. */
  priceMatch?: 'OPPONENT' | 'OPPONENT_5' | 'OPPONENT_10' | 'OPPONENT_20' | 'QUEUE' | 'QUEUE_5' | 'QUEUE_10' | 'QUEUE_20' | 'NONE';
}

/**
 * Amend an open LIMIT/STOP/TAKE_PROFIT order in-place without cancel+resubmit.
 * Only `quantity` and `price` can be changed; side and type are immutable.
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Modify-Order
 */
export const modifyOrder = async (client: BinanceRestClient, params: ModifyOrderParams): Promise<OrderResult> => {
  const body: Record<string, string | number> = {
    symbol: params.symbol.toUpperCase(),
    orderId: params.orderId,
    side: params.side,
    quantity: params.quantity,
    price: params.price,
  };
  if (params.priceMatch !== undefined) body.priceMatch = params.priceMatch;
  return client.signedPut<OrderResult>('/fapi/v1/order', body);
};

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

const serializeOrderParams = (p: PlaceOrderParams): Record<string, string | number | boolean> => {
  const o: Record<string, string | number | boolean> = {
    symbol: p.symbol.toUpperCase(),
    side: p.side,
    type: p.type,
    newOrderRespType: p.newOrderRespType ?? 'RESULT',
  };
  if (p.quantity !== undefined) o.quantity = p.quantity;
  if (p.price !== undefined) o.price = p.price;
  if (p.stopPrice !== undefined) o.stopPrice = p.stopPrice;
  if (p.callbackRate !== undefined) o.callbackRate = p.callbackRate;
  if (p.timeInForce !== undefined) o.timeInForce = p.timeInForce;
  if (p.workingType !== undefined) o.workingType = p.workingType;
  if (p.positionSide !== undefined) o.positionSide = p.positionSide;
  if (p.reduceOnly !== undefined) o.reduceOnly = p.reduceOnly;
  if (p.closePosition !== undefined) o.closePosition = p.closePosition;
  if (p.newClientOrderId !== undefined) o.newClientOrderId = p.newClientOrderId;
  if (p.activationPrice !== undefined) o.activationPrice = p.activationPrice;
  return o;
};

/** Place up to 5 orders atomically. All succeed or all fail. */
export const placeBatchOrders = async (client: BinanceRestClient, orders: PlaceOrderParams[]): Promise<OrderResult[]> => {
  return client.signedPost<OrderResult[]>('/fapi/v1/batchOrders', {
    batchOrders: JSON.stringify(orders.map(serializeOrderParams)),
  });
};

export interface ModifyBatchOrderParams {
  symbol: string;
  orderId: number;
  side: OrderSide;
  quantity: number;
  price: number;
}

/** Modify up to 5 orders atomically. */
export const modifyBatchOrders = async (
  client: BinanceRestClient,
  orders: ModifyBatchOrderParams[],
): Promise<OrderResult[]> => {
  const batch = orders.map((o) => ({
    symbol: o.symbol.toUpperCase(),
    orderId: o.orderId,
    side: o.side,
    quantity: o.quantity,
    price: o.price,
  }));
  return client.signedPut<OrderResult[]>('/fapi/v1/batchOrders', {
    batchOrders: JSON.stringify(batch),
  });
};

/** Cancel up to 10 orders by orderId list. */
export const cancelBatchOrders = async (
  client: BinanceRestClient,
  symbol: string,
  orderIdList: number[],
): Promise<OrderResult[]> => {
  return client.signedDelete<OrderResult[]>('/fapi/v1/batchOrders', {
    symbol: symbol.toUpperCase(),
    orderIdList: JSON.stringify(orderIdList),
  });
};

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

// ─── Commission Rate ──────────────────────────────────────────────────────

export interface CommissionRate {
  symbol: string;
  makerCommissionRate: string;
  takerCommissionRate: string;
}

/**
 * Fetch actual maker/taker commission rate for a symbol.
 * Replaces hardcoded fee constants with real user-specific rates.
 */
export const getCommissionRate = async (
  client: BinanceRestClient,
  symbol: string,
): Promise<CommissionRate> => {
  return client.signedGet<CommissionRate>('/fapi/v1/commissionRate', {
    symbol: symbol.toUpperCase(),
  });
};

// ─── Position mode (hedge vs one-way) ─────────────────────────────────────

export interface PositionSideDualResponse {
  dualSidePosition: boolean;
}

export const getPositionSideDual = async (client: BinanceRestClient): Promise<PositionSideDualResponse> => {
  return client.signedGet<PositionSideDualResponse>('/fapi/v1/positionSide/dual');
}

// ─── Leverage Brackets (notional tiers) ──────────────────────────────────

export interface LeverageBracketTier {
  bracket: number;
  initialLeverage: number;
  notionalCap: number;
  notionalFloor: number;
  maintMarginRatio: number;
  cum: number;
}

export interface SymbolLeverageBracket {
  symbol: string;
  notionalCoef?: number;
  brackets: LeverageBracketTier[];
}

/** Fetch leverage bracket tiers for one symbol or all symbols. */
export const getLeverageBracket = async (
  client: BinanceRestClient,
  symbol?: string,
): Promise<SymbolLeverageBracket[]> => {
  const params: Record<string, string> = {};
  if (symbol) params.symbol = symbol.toUpperCase();
  const raw = await client.signedGet<SymbolLeverageBracket | SymbolLeverageBracket[]>(
    '/fapi/v1/leverageBracket',
    params,
  );
  return Array.isArray(raw) ? raw : [raw];
};

/**
 * Find the bracket tier that applies for a given notional value.
 * Returns the tier whose `notionalFloor <= notional < notionalCap`.
 */
export const bracketForNotional = (
  brackets: LeverageBracketTier[],
  notional: number,
): LeverageBracketTier | null => {
  const sorted = [...brackets].sort((a, b) => a.notionalFloor - b.notionalFloor);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (notional >= sorted[i].notionalFloor) return sorted[i];
  }
  return sorted[0] ?? null;
};

/**
 * Check whether a proposed position notional exceeds the max allowed for
 * the requested leverage. Returns `{ ok, maxNotional, maxLeverage, tier }`.
 */
export const validateNotionalAgainstBracket = (
  brackets: LeverageBracketTier[],
  notional: number,
  requestedLeverage: number,
): { ok: boolean; maxNotional: number; maxLeverage: number; tier: LeverageBracketTier | null } => {
  const tier = bracketForNotional(brackets, notional);
  if (!tier) return { ok: false, maxNotional: 0, maxLeverage: 0, tier: null };
  const ok = requestedLeverage <= tier.initialLeverage && notional <= tier.notionalCap;
  return { ok, maxNotional: tier.notionalCap, maxLeverage: tier.initialLeverage, tier };
};

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

// ─── Income History (realized PnL, fees, funding) ────────────────────────

export type IncomeType =
  | 'TRANSFER'
  | 'WELCOME_BONUS'
  | 'REALIZED_PNL'
  | 'FUNDING_FEE'
  | 'COMMISSION'
  | 'INSURANCE_CLEAR'
  | 'REFERRAL_KICKBACK'
  | 'COMMISSION_REBATE'
  | 'API_REBATE'
  | 'CONTEST_REWARD'
  | 'CROSS_COLLATERAL_TRANSFER'
  | 'OPTIONS_PREMIUM_FEE'
  | 'OPTIONS_SETTLE_PROFIT'
  | 'INTERNAL_TRANSFER'
  | 'AUTO_EXCHANGE'
  | 'DELIVERED_SETTELMENT'
  | 'COIN_SWAP_DEPOSIT'
  | 'COIN_SWAP_WITHDRAW'
  | 'POSITION_LIMIT_INCREASE_FEE';

export interface IncomeRow {
  symbol: string;
  incomeType: IncomeType;
  income: string;
  asset: string;
  info: string;
  time: number;
  tranId: number;
  tradeId: string;
}

export interface GetIncomeParams {
  symbol?: string;
  incomeType?: IncomeType;
  startTime?: number;
  endTime?: number;
  page?: number;
  limit?: number;
}

/**
 * Fetch income history: realized PnL, funding fees, commissions, transfers, etc.
 * Max 1000 rows per call. Use `startTime`/`endTime` for pagination.
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Income-History
 */
export const getIncomeHistory = async (
  client: BinanceRestClient,
  params: GetIncomeParams = {},
): Promise<IncomeRow[]> => {
  const q: Record<string, string | number> = {};
  if (params.symbol) q.symbol = params.symbol.toUpperCase();
  if (params.incomeType) q.incomeType = params.incomeType;
  if (params.startTime !== undefined) q.startTime = params.startTime;
  if (params.endTime !== undefined) q.endTime = params.endTime;
  if (params.page !== undefined) q.page = params.page;
  if (params.limit !== undefined) q.limit = params.limit;
  return client.signedGet<IncomeRow[]>('/fapi/v1/income', q);
};

// ─── Open Interest ─────────────────────────────────────────────────────────

export interface OpenInterestResponse {
  symbol: string;
  openInterest: string;
  time: number;
}

/** Current open interest for a symbol. Poll every 5–10 s for OI delta signals. */
export const getOpenInterest = async (
  client: BinanceRestClient,
  symbol: string,
): Promise<OpenInterestResponse> => {
  return client.publicGet<OpenInterestResponse>('/fapi/v1/openInterest', {
    symbol: symbol.toUpperCase(),
  });
};

export interface OpenInterestHistRow {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

export type OiHistPeriod = '5m' | '15m' | '30m' | '1h' | '2h' | '4h' | '6h' | '12h' | '1d';

/**
 * Historical OI statistics — 5m to 1d intervals.
 * Public endpoint (no signature needed), max 500 rows.
 */
export const getOpenInterestHist = async (
  client: BinanceRestClient,
  params: { symbol: string; period: OiHistPeriod; limit?: number; startTime?: number; endTime?: number },
): Promise<OpenInterestHistRow[]> => {
  const q: Record<string, string | number> = {
    symbol: params.symbol.toUpperCase(),
    period: params.period,
  };
  if (params.limit !== undefined) q.limit = params.limit;
  if (params.startTime !== undefined) q.startTime = params.startTime;
  if (params.endTime !== undefined) q.endTime = params.endTime;
  return client.publicGet<OpenInterestHistRow[]>('/futures/data/openInterestHist', q);
};

// ─── Funding Rate ──────────────────────────────────────────────────────────

export interface FundingRateRow {
  symbol: string;
  fundingRate: string;
  fundingTime: number;
  markPrice: string;
}

/**
 * Funding rate history. Max 1000 rows per call.
 * Use `startTime`/`endTime` for pagination.
 */
export const getFundingRateHistory = async (
  client: BinanceRestClient,
  params: { symbol?: string; startTime?: number; endTime?: number; limit?: number } = {},
): Promise<FundingRateRow[]> => {
  const q: Record<string, string | number> = {};
  if (params.symbol) q.symbol = params.symbol.toUpperCase();
  if (params.startTime !== undefined) q.startTime = params.startTime;
  if (params.endTime !== undefined) q.endTime = params.endTime;
  if (params.limit !== undefined) q.limit = params.limit;
  return client.publicGet<FundingRateRow[]>('/fapi/v1/fundingRate', q);
};

// ─── Server Time ───────────────────────────────────────────────────────────

export const getServerTime = async (client: BinanceRestClient): Promise<number> => {
  const res = await client.publicGet<{ serverTime: number }>('/fapi/v1/time');
  return res.serverTime;
}
