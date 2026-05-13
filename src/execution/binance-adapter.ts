import { createHash, randomUUID } from 'node:crypto';
import type { BinanceRestClient } from '../binance/rest-client';
import {
  setLeverage,
  setMarginType,
  placeOrder,
  placeBatchOrders,
  placeAlgoOrder,
  modifyOrder,
  cancelAllOrders,
  cancelAllAlgoOrders,
  cancelAlgoOrder,
  getPositionRisk,
  getOpenAlgoOrders,
  type AlgoOrderResult,
  type FuturesPositionRisk,
  type PlaceOrderParams,
  type OrderResult as BinanceOrderResult,
} from '../binance/rest-trade';
import { floorToStep, roundToTick } from '../mapping/precision';
import type { InstrumentPrecision } from '../mapping/precision';

const generateClientOrderId = (symbol: string, side: string, ts = Date.now()): string => {
  const raw = `${symbol}:${side}:${ts}`;
  return 'bot_' + createHash('sha256').update(raw).digest('hex').slice(0, 28);
};
import type {
  CloseReason,
  ClosedPosition,
  ExecutionAdapter,
  Fill,
  OrderRequest,
  OrderResult,
} from './types';

export interface BinanceAdapterOptions {
  client: BinanceRestClient;
  /** Symbol traded (e.g. SOLUSDT). */
  symbol: string;
  takerFee: number;
  makerFee?: number;
  fundingFeeEst: number;
  /** Margin type: ISOLATED (default) or CROSSED. */
  marginType?: 'ISOLATED' | 'CROSSED';
  /**
   * When true (dual / hedge position mode), all orders include `positionSide` LONG/SHORT.
   * Set from `GET /fapi/v1/positionSide/dual` during startup reconciliation.
   */
  hedgeMode?: boolean;
  /** MARKET (default) or LIMIT_GTX for post-only maker fill. */
  entryOrderType?: 'MARKET' | 'LIMIT_GTX';
  /** Trailing stop callback rate (%). 0 = use fixed SL. */
  trailingStopCallbackRate?: number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface OpenLiveTrade {
  internalId: string;
  binanceOrderId: number;
  /** Algo service strategyIds for TP orders — cancelled on manual close. */
  tp1StrategyId: number | null;
  tp2StrategyId: number | null;
  /** Algo service strategyId for SL order. */
  slStrategyId: number | null;
  side: 'LONG' | 'SHORT';
  symbol: string;
  entryPrice: number;
  /** Full position quantity (before any partial TP fills). */
  quantity: number;
  /** Remaining open quantity (decrements as TP1 partial fills). */
  remainingQty: number;
  openedAt: number;
  entryFeeUsdt: number;
  stepSize: number;
  tickSize: number;
}

/**
 * Live execution adapter for Binance USD-M Futures.
 *
 * TP/SL use the Algo Service (`POST /fapi/v1/algoOrder`) per Dec 2025 migration.
 * Quantities are floored to stepSize; prices are rounded to tickSize.
 *
 * Order flow:
 *   1. POST /fapi/v1/leverage
 *   2. POST /fapi/v1/marginType (ISOLATED, idempotent)
 *   3. POST /fapi/v1/order  → MARKET entry
 *   4. POST /fapi/v1/algoOrder → TAKE_PROFIT_MARKET TP1 (60% qty at 0.9%)
 *   5. POST /fapi/v1/algoOrder → TAKE_PROFIT_MARKET TP2 (closePosition at 1.5%)
 *   6. POST /fapi/v1/algoOrder → STOP_MARKET SL (closePosition)
 *
 * On exchange-triggered fill (ORDER_TRADE_UPDATE):
 *   call notifyFilled(internalId, strategyId, fillPrice) so the adapter
 *   cancels remaining orders and cleans internal state without sending
 *   a redundant MARKET close.
 *
 * On bot-initiated close (REVERSAL / MANUAL):
 *   closePosition() cancels all algo orders then sends a MARKET reduceOnly.
 */
export class BinanceLiveExecutionAdapter implements ExecutionAdapter {
  readonly name = 'live' as const;
  private trades = new Map<string, OpenLiveTrade>();
  /** Maps Binance strategyId → internalId for reverse lookup from ORDER_TRADE_UPDATE. */
  private algoIdToInternal = new Map<number, string>();
  private lastMark = 0;
  private precision: InstrumentPrecision = { tickSize: 0.01, stepSize: 0.1, minQty: 0.1 };
  /** Prevents concurrent close attempts for the same position. */
  private closingIds = new Set<string>();
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;
  private hedgeMode: boolean;

  constructor(private readonly opts: BinanceAdapterOptions) {
    this.log = opts.log ?? ((msg, meta) => process.stdout.write(`${msg} ${JSON.stringify(meta ?? {})}\n`));
    this.hedgeMode = opts.hedgeMode ?? false;
  }

  /** Enable hedge-mode order tagging (LONG/SHORT on each order). */
  setHedgeMode(dualSidePosition: boolean): void {
    this.hedgeMode = dualSidePosition;
  }

  private positionSideFor(tradeSide: 'LONG' | 'SHORT'): 'LONG' | 'SHORT' | undefined {
    if (!this.hedgeMode) return undefined;
    return tradeSide;
  }

  /** Called by orchestrator after exchangeInfo precision is loaded. */
  setPrecision(p: InstrumentPrecision): void {
    this.precision = p;
  }

  onMark(_symbol: string, markPrice: number): void {
    this.lastMark = markPrice;
  }

  async setLeverage(_pair: string, lev: number): Promise<void> {
    await setLeverage(this.opts.client, this.opts.symbol.toUpperCase(), lev);
  }

  // ─── Place entry + algo TP/SL ─────────────────────────────────────────────

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const sym = this.opts.symbol.toUpperCase();
    const startedAt = Date.now();
    const { stepSize, tickSize } = this.precision;

    await this.setupSymbol(sym, req.leverage);

    const entrySide = req.side === 'LONG' ? 'BUY' : 'SELL';
    const qty = floorToStep(req.quantity, stepSize);
    if (qty <= 0) {
      return this.failResult(req.referencePrice, req.quantity, startedAt, 'quantity below stepSize');
    }

    const clientOrderId = generateClientOrderId(sym, entrySide);
    const useGtx = this.opts.entryOrderType === 'LIMIT_GTX';

    const orderParams: PlaceOrderParams = {
      symbol: sym,
      side: entrySide,
      type: useGtx ? 'LIMIT' : 'MARKET',
      quantity: qty,
      newOrderRespType: 'RESULT',
      positionSide: this.positionSideFor(req.side),
      newClientOrderId: clientOrderId,
    };

    if (useGtx) {
      orderParams.price = roundToTick(req.referencePrice, tickSize);
      orderParams.timeInForce = 'GTX';
    }

    let entryOrder;
    try {
      entryOrder = await placeOrder(this.opts.client, orderParams);
    } catch (e) {
      return this.failResult(req.referencePrice, qty, startedAt, (e as Error).message);
    }

    const fillPrice = Number(entryOrder.avgPrice) || req.referencePrice;
    const latencyMs = Date.now() - startedAt;
    const fee = useGtx ? (this.opts.makerFee ?? this.opts.takerFee) : this.opts.takerFee;
    const entryFee = fillPrice * qty * fee;
    const slippageBps = req.referencePrice > 0
      ? ((fillPrice - req.referencePrice) / req.referencePrice) * 10_000
      : 0;
    this.log('slippage_log', { sym, side: entrySide, refPrice: req.referencePrice, fillPrice, slippageBps: +slippageBps.toFixed(2), latencyMs });

    const internalId = randomUUID();
    const trade: OpenLiveTrade = {
      internalId,
      binanceOrderId: entryOrder.orderId,
      tp1StrategyId: null,
      tp2StrategyId: null,
      slStrategyId: null,
      side: req.side,
      symbol: sym,
      entryPrice: fillPrice,
      quantity: qty,
      remainingQty: qty,
      openedAt: Date.now(),
      entryFeeUsdt: entryFee,
      stepSize,
      tickSize,
    };

    const closeSide = req.side === 'LONG' ? 'SELL' : 'BUY';
    await this.attachAlgoTpSl(trade, closeSide, fillPrice, req.takeProfit, req.stopLoss, qty);

    this.trades.set(internalId, trade);
    this.log('binance_order_placed', {
      id: internalId,
      binanceOrderId: entryOrder.orderId,
      side: req.side,
      fillPrice,
      qty,
      tp1: trade.tp1StrategyId,
      tp2: trade.tp2StrategyId,
      sl: trade.slStrategyId,
    });

    const fill: Fill = {
      price: fillPrice,
      quantity: qty,
      feeUsdt: entryFee,
      slippageUsdt: Math.abs(fillPrice - req.referencePrice) * qty,
      latencyMs,
      timestamp: Date.now(),
    };
    return { ok: true, orderId: internalId, fill, positionId: internalId };
  }

  // ─── Atomic batch entry + bracket ─────────────────────────────────────────

  /**
   * Submit MARKET entry + STOP SL + TAKE_PROFIT TP as a single batch request.
   * Uses regular order types (not algo) so all 3 fit in one `POST /fapi/v1/batchOrders`.
   * Falls back to sequential placement if the batch call fails.
   *
   * Note: regular STOP/TAKE_PROFIT orders require a `price` (limit) and `stopPrice` (trigger).
   * For market-on-trigger behavior, use the existing `placeOrder` flow with algo orders instead.
   */
  async placeEntryWithBracket(req: OrderRequest): Promise<OrderResult> {
    const sym = this.opts.symbol.toUpperCase();
    const startedAt = Date.now();
    const { stepSize, tickSize } = this.precision;

    await this.setupSymbol(sym, req.leverage);

    const entrySide: 'BUY' | 'SELL' = req.side === 'LONG' ? 'BUY' : 'SELL';
    const closeSide: 'BUY' | 'SELL' = req.side === 'LONG' ? 'SELL' : 'BUY';
    const qty = floorToStep(req.quantity, stepSize);
    if (qty <= 0) {
      return this.failResult(req.referencePrice, req.quantity, startedAt, 'quantity below stepSize');
    }

    const tpPrice = req.takeProfit ?? (req.side === 'LONG' ? req.referencePrice * 1.015 : req.referencePrice * 0.985);
    const slPrice = req.stopLoss ?? (req.side === 'LONG' ? req.referencePrice * 0.99 : req.referencePrice * 1.01);

    const entryParams: PlaceOrderParams = {
      symbol: sym,
      side: entrySide,
      type: 'MARKET',
      quantity: qty,
      newOrderRespType: 'RESULT',
      positionSide: this.positionSideFor(req.side),
    };

    const tpParams: PlaceOrderParams = {
      symbol: sym,
      side: closeSide,
      type: 'TAKE_PROFIT',
      quantity: qty,
      price: roundToTick(tpPrice, tickSize),
      stopPrice: roundToTick(tpPrice, tickSize),
      timeInForce: 'GTC',
      workingType: 'MARK_PRICE',
      reduceOnly: true,
      positionSide: this.positionSideFor(req.side),
    };

    const slParams: PlaceOrderParams = {
      symbol: sym,
      side: closeSide,
      type: 'STOP',
      quantity: qty,
      price: roundToTick(slPrice, tickSize),
      stopPrice: roundToTick(slPrice, tickSize),
      timeInForce: 'GTC',
      workingType: 'MARK_PRICE',
      reduceOnly: true,
      positionSide: this.positionSideFor(req.side),
    };

    try {
      const results = await placeBatchOrders(this.opts.client, [entryParams, tpParams, slParams]);
      const entryResult = results[0];
      if (!entryResult || entryResult.status === 'REJECTED') {
        return this.failResult(req.referencePrice, qty, startedAt, 'batch entry rejected');
      }

      const fillPrice = Number(entryResult.avgPrice) || req.referencePrice;
      const entryFee = fillPrice * qty * this.opts.takerFee;
      const internalId = randomUUID();

      const trade: OpenLiveTrade = {
        internalId,
        binanceOrderId: entryResult.orderId,
        tp1StrategyId: null,
        tp2StrategyId: null,
        slStrategyId: null,
        side: req.side,
        symbol: sym,
        entryPrice: fillPrice,
        quantity: qty,
        remainingQty: qty,
        openedAt: Date.now(),
        entryFeeUsdt: entryFee,
        stepSize,
        tickSize,
      };

      this.trades.set(internalId, trade);
      this.log('binance_batch_order_placed', {
        id: internalId,
        entryOrderId: entryResult.orderId,
        tpOrderId: results[1]?.orderId,
        slOrderId: results[2]?.orderId,
        fillPrice,
        qty,
      });

      const fill: Fill = {
        price: fillPrice,
        quantity: qty,
        feeUsdt: entryFee,
        slippageUsdt: Math.abs(fillPrice - req.referencePrice) * qty,
        latencyMs: Date.now() - startedAt,
        timestamp: Date.now(),
      };
      return { ok: true, orderId: internalId, fill, positionId: internalId };
    } catch (e) {
      this.log('binance_batch_fallback', { err: (e as Error).message });
      return this.placeOrder(req);
    }
  }

  // ─── Bot-initiated close (REVERSAL / MANUAL / SL via onMark) ─────────────

  async closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
    const trade = this.trades.get(orderId);
    if (!trade) throw new Error(`binance_close_unknown:${orderId}`);

    // Guard: if already being closed, don't send duplicate orders.
    if (this.closingIds.has(orderId)) {
      throw new Error(`binance_close_already_in_progress:${orderId}`);
    }
    this.closingIds.add(orderId);

    // Remove from map immediately so no other path can try to close it.
    this.trades.delete(orderId);
    this.cleanAlgoIndex(trade);

    let exitPrice = this.lastMark || trade.entryPrice;

    // 1. Cancel remaining algo TP/SL orders.
    await Promise.allSettled([
      cancelAllAlgoOrders(this.opts.client, trade.symbol),
      cancelAllOrders(this.opts.client, trade.symbol),
    ]);

    // 2. Market close (reduceOnly = true).
    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
    try {
      const closeOrder = await placeOrder(this.opts.client, {
        symbol: trade.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: trade.remainingQty,
        reduceOnly: true,
        newOrderRespType: 'RESULT',
        positionSide: this.positionSideFor(trade.side),
      });
      const avg = Number(closeOrder.avgPrice);
      if (Number.isFinite(avg) && avg > 0) exitPrice = avg;
    } catch {
      // Position may already be closed by exchange TP/SL — fetch mark as fallback.
      const positions = await getPositionRisk(this.opts.client, trade.symbol).catch(() => []);
      const pos = positions.find((p) => p.symbol === trade.symbol);
      if (pos) {
        const mp = Number(pos.markPrice);
        if (Number.isFinite(mp) && mp > 0) exitPrice = mp;
      }
    }

    this.closingIds.delete(orderId);
    this.log('binance_position_closed', { id: orderId, reason, exitPrice });
    return this.buildClosedPosition(trade, exitPrice, reason);
  }

  // ─── Exchange-triggered close (called from ORDER_TRADE_UPDATE FILLED) ──────

  /**
   * Called by the orchestrator when a TP or SL algo order is FILLED by the exchange.
   * Cancels sibling orders and removes internal state without sending a new market order.
   * Returns the ClosedPosition for the position manager to log, or null if unknown.
   */
  notifyFilled(strategyId: number, fillPrice: number): { closed: ClosedPosition; internalId: string; fullyFilled: boolean } | null {
    const internalId = this.algoIdToInternal.get(strategyId);
    if (!internalId) return null;
    const trade = this.trades.get(internalId);
    if (!trade) return null;

    const isTp1 = trade.tp1StrategyId === strategyId;
    const isTp2 = trade.tp2StrategyId === strategyId;
    const isSl = trade.slStrategyId === strategyId;

    if (isTp1) {
      // Partial close — 60% qty filled. Update remaining, leave position open.
      const tp1Qty = floorToStep(trade.quantity * 0.6, trade.stepSize);
      trade.remainingQty = floorToStep(trade.quantity - tp1Qty, trade.stepSize);
      trade.tp1StrategyId = null;
      this.algoIdToInternal.delete(strategyId);
      this.log('binance_tp1_filled', { id: internalId, fillPrice, remainingQty: trade.remainingQty });
      return null; // Position still partially open — don't close position manager yet.
    }

    if (isTp2 || isSl) {
      // Full close — remove trade and cancel siblings.
      this.trades.delete(internalId);
      this.cleanAlgoIndex(trade);
      void Promise.allSettled([
        cancelAllAlgoOrders(this.opts.client, trade.symbol),
        cancelAllOrders(this.opts.client, trade.symbol),
      ]);
      const reason: CloseReason = isSl ? 'SL' : 'TP';
      this.log('binance_exchange_close', { id: internalId, strategyId, reason, fillPrice });
      return { closed: this.buildClosedPosition(trade, fillPrice, reason), internalId, fullyFilled: true };
    }

    return null;
  }

  /**
   * Restore a position that was open before the bot restarted.
   * Called by the orchestrator during startup reconciliation.
   */
  restoreFromExchange(
    pos: FuturesPositionRisk,
    openAlgoOrders: AlgoOrderResult[],
  ): string | null {
    const amt = Number(pos.positionAmt);
    const entryPrice = Number(pos.entryPrice);
    if (!Number.isFinite(amt) || amt === 0 || !Number.isFinite(entryPrice)) return null;

    const side: 'LONG' | 'SHORT' = amt > 0 ? 'LONG' : 'SHORT';
    const qty = Math.abs(amt);
    const sym = pos.symbol.toUpperCase();
    const internalId = randomUUID();
    const { stepSize, tickSize } = this.precision;

    const trade: OpenLiveTrade = {
      internalId,
      binanceOrderId: 0,
      tp1StrategyId: null,
      tp2StrategyId: null,
      slStrategyId: null,
      side,
      symbol: sym,
      entryPrice,
      quantity: qty,
      remainingQty: qty,
      openedAt: pos.updateTime || Date.now(),
      entryFeeUsdt: entryPrice * qty * this.opts.takerFee,
      stepSize,
      tickSize,
    };

    // Re-attach known algo orders so cancel-on-close works.
    const closeSide = side === 'LONG' ? 'SELL' : 'BUY';
    for (const o of openAlgoOrders) {
      if (o.symbol.toUpperCase() !== sym || o.side.toUpperCase() !== closeSide) continue;
      const isTP = o.type === 'TAKE_PROFIT_MARKET';
      const isSL = o.type === 'STOP_MARKET';
      if (isTP && trade.tp1StrategyId === null) {
        trade.tp1StrategyId = o.strategyId;
        this.algoIdToInternal.set(o.strategyId, internalId);
      } else if (isTP && trade.tp2StrategyId === null) {
        trade.tp2StrategyId = o.strategyId;
        this.algoIdToInternal.set(o.strategyId, internalId);
      } else if (isSL && trade.slStrategyId === null) {
        trade.slStrategyId = o.strategyId;
        this.algoIdToInternal.set(o.strategyId, internalId);
      }
    }

    this.trades.set(internalId, trade);
    this.log('binance_position_restored', { internalId, side, qty, entryPrice, sym });
    return internalId;
  }

  /** Returns the internalId → trade mapping for the given algo strategyId. */
  lookupByStrategyId(strategyId: number): { internalId: string; trade: OpenLiveTrade } | null {
    const internalId = this.algoIdToInternal.get(strategyId);
    if (!internalId) return null;
    const trade = this.trades.get(internalId);
    if (!trade) return null;
    return { internalId, trade };
  }

  hasOpenTrade(internalId: string): boolean {
    return this.trades.has(internalId);
  }

  /**
   * Amend a regular (non-algo) order's price and/or quantity in-place.
   * Avoids the cancel+resubmit round-trip. Only works for LIMIT/STOP/TAKE_PROFIT types.
   */
  async modifyRegularOrder(
    orderId: number,
    side: 'BUY' | 'SELL',
    newPrice: number,
    newQuantity: number,
  ): Promise<BinanceOrderResult> {
    const sym = this.opts.symbol.toUpperCase();
    const { tickSize, stepSize } = this.precision;
    return modifyOrder(this.opts.client, {
      symbol: sym,
      orderId,
      side,
      price: roundToTick(newPrice, tickSize),
      quantity: floorToStep(newQuantity, stepSize),
    });
  }

  /**
   * Amend an algo TP or SL stop price for an open position.
   * Algo orders cannot be modified in-place — this does cancel+replace atomically.
   * Returns the new strategyId on success, or null if the cancel or replace failed.
   */
  async amendAlgoStopPrice(
    internalId: string,
    target: 'TP1' | 'TP2' | 'SL',
    newStopPrice: number,
  ): Promise<number | null> {
    const trade = this.trades.get(internalId);
    if (!trade) return null;

    const sym = trade.symbol;
    const { tickSize, stepSize } = trade;
    const closeSide: 'BUY' | 'SELL' = trade.side === 'LONG' ? 'SELL' : 'BUY';

    const oldStrategyId =
      target === 'TP1' ? trade.tp1StrategyId
      : target === 'TP2' ? trade.tp2StrategyId
      : trade.slStrategyId;

    if (oldStrategyId !== null) {
      try {
        await cancelAlgoOrder(this.opts.client, sym, oldStrategyId);
      } catch (e) {
        this.log('binance_amend_cancel_warn', { target, oldStrategyId, err: (e as Error).message });
      }
      this.algoIdToInternal.delete(oldStrategyId);
    }

    const algoType = target === 'SL' ? 'STOP_MARKET' as const : 'TAKE_PROFIT_MARKET' as const;
    const useClosePosition = target !== 'TP1';
    const qty = target === 'TP1' ? floorToStep(trade.quantity * 0.6, stepSize) : undefined;

    try {
      const r = await placeAlgoOrder(this.opts.client, {
        symbol: sym,
        side: closeSide,
        type: algoType,
        stopPrice: roundToTick(newStopPrice, tickSize),
        quantity: qty,
        closePosition: useClosePosition || undefined,
        reduceOnly: target === 'TP1' || undefined,
        workingType: 'MARK_PRICE',
        timeInForce: 'GTE_GTC',
        positionSide: this.positionSideFor(trade.side),
      });

      if (target === 'TP1') trade.tp1StrategyId = r.strategyId;
      else if (target === 'TP2') trade.tp2StrategyId = r.strategyId;
      else trade.slStrategyId = r.strategyId;

      this.algoIdToInternal.set(r.strategyId, internalId);
      this.log('binance_algo_amended', { internalId, target, newStopPrice, newStrategyId: r.strategyId });
      return r.strategyId;
    } catch (e) {
      this.log('binance_amend_replace_failed', { internalId, target, err: (e as Error).message });
      return null;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async setupSymbol(sym: string, leverage: number): Promise<void> {
    try {
      await setLeverage(this.opts.client, sym, leverage);
    } catch (e) {
      this.log('binance_set_leverage_warn', { sym, err: (e as Error).message });
    }
    try {
      await setMarginType(this.opts.client, sym, this.opts.marginType ?? 'ISOLATED');
    } catch (e) {
      this.log('binance_set_margin_warn', { sym, err: (e as Error).message });
    }
  }

  /**
   * Place TP1 (partial, 60% at 0.9%), TP2 (full close at 1.5%), SL (full close).
   * All go to the Algo Service (POST /fapi/v1/algoOrder) per Dec 2025 migration.
   */
  private async attachAlgoTpSl(
    trade: OpenLiveTrade,
    closeSide: 'BUY' | 'SELL',
    entryPrice: number,
    tpPrice: number | undefined,
    slPrice: number | undefined,
    qty: number,
  ): Promise<void> {
    const sym = trade.symbol;
    const { stepSize, tickSize } = trade;

    const tp2Price = tpPrice ?? (trade.side === 'LONG' ? entryPrice * 1.015 : entryPrice * 0.985);
    const sl = slPrice ?? (trade.side === 'LONG' ? entryPrice * 0.99 : entryPrice * 1.01);
    const tp1Price = trade.side === 'LONG' ? entryPrice * 1.009 : entryPrice * 0.991;

    // TP1: 60% of qty, partial reduce.
    const tp1Qty = floorToStep(qty * 0.6, stepSize);

    if (tp1Qty > 0) {
      try {
        const r = await placeAlgoOrder(this.opts.client, {
          symbol: sym,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: roundToTick(tp1Price, tickSize),
          quantity: tp1Qty,
          workingType: 'MARK_PRICE',
          reduceOnly: true,
          timeInForce: 'GTE_GTC',
          positionSide: this.positionSideFor(trade.side),
        });
        trade.tp1StrategyId = r.strategyId;
        this.algoIdToInternal.set(r.strategyId, trade.internalId);
      } catch (e) {
        this.log('binance_tp1_warn', { sym, err: (e as Error).message });
      }
    }

    // TP2: close full remaining position.
    try {
      const r = await placeAlgoOrder(this.opts.client, {
        symbol: sym,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: roundToTick(tp2Price, tickSize),
        closePosition: true,
        workingType: 'MARK_PRICE',
        timeInForce: 'GTE_GTC',
        positionSide: this.positionSideFor(trade.side),
      });
      trade.tp2StrategyId = r.strategyId;
      this.algoIdToInternal.set(r.strategyId, trade.internalId);
    } catch (e) {
      this.log('binance_tp2_warn', { sym, err: (e as Error).message });
    }

    // SL: trailing stop if configured, otherwise fixed stop-market.
    const trailRate = this.opts.trailingStopCallbackRate ?? 0;
    try {
      if (trailRate > 0) {
        const r = await placeAlgoOrder(this.opts.client, {
          symbol: sym,
          side: closeSide,
          type: 'TRAILING_STOP_MARKET',
          callbackRate: trailRate,
          activationPrice: roundToTick(entryPrice, tickSize),
          closePosition: true,
          workingType: 'MARK_PRICE',
          timeInForce: 'GTE_GTC',
          positionSide: this.positionSideFor(trade.side),
        });
        trade.slStrategyId = r.strategyId;
        this.algoIdToInternal.set(r.strategyId, trade.internalId);
      } else {
        const r = await placeAlgoOrder(this.opts.client, {
          symbol: sym,
          side: closeSide,
          type: 'STOP_MARKET',
          stopPrice: roundToTick(sl, tickSize),
          closePosition: true,
          workingType: 'MARK_PRICE',
          timeInForce: 'GTE_GTC',
          positionSide: this.positionSideFor(trade.side),
        });
        trade.slStrategyId = r.strategyId;
        this.algoIdToInternal.set(r.strategyId, trade.internalId);
      }
    } catch (e) {
      this.log('binance_sl_warn', { sym, err: (e as Error).message });
    }
  }

  private buildClosedPosition(trade: OpenLiveTrade, exitPrice: number, reason: CloseReason): ClosedPosition {
    const sideMul = trade.side === 'LONG' ? 1 : -1;
    const gross = (exitPrice - trade.entryPrice) * trade.quantity * sideMul;
    const exitFee = exitPrice * trade.remainingQty * this.opts.takerFee;
    const funding = trade.entryPrice * trade.quantity * this.opts.fundingFeeEst;
    return {
      orderId: trade.internalId,
      side: trade.side,
      entryPrice: trade.entryPrice,
      exitPrice,
      quantity: trade.quantity,
      reason,
      grossUsdt: gross,
      feesUsdt: trade.entryFeeUsdt + exitFee,
      fundingUsdt: funding,
      netUsdt: gross - trade.entryFeeUsdt - exitFee - funding,
      openedAt: trade.openedAt,
      closedAt: Date.now(),
    };
  }

  private cleanAlgoIndex(trade: OpenLiveTrade): void {
    if (trade.tp1StrategyId !== null) this.algoIdToInternal.delete(trade.tp1StrategyId);
    if (trade.tp2StrategyId !== null) this.algoIdToInternal.delete(trade.tp2StrategyId);
    if (trade.slStrategyId !== null) this.algoIdToInternal.delete(trade.slStrategyId);
  }

  private failResult(refPrice: number, qty: number, startedAt: number, error: string): OrderResult {
    return {
      ok: false,
      orderId: randomUUID(),
      fill: { price: refPrice, quantity: qty, feeUsdt: 0, slippageUsdt: 0, latencyMs: Date.now() - startedAt, timestamp: Date.now() },
      error,
    };
  }
}

// Re-export types needed by orchestrator
export type { AlgoOrderResult, FuturesPositionRisk, getOpenAlgoOrders };
