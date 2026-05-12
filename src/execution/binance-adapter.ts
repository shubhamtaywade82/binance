import { randomUUID } from 'node:crypto';
import type { BinanceRestClient } from '../binance/rest-client';
import {
  setLeverage,
  setMarginType,
  placeOrder,
  placeAlgoOrder,
  cancelAllOrders,
  cancelAllAlgoOrders,
  getPositionRisk,
  getOpenAlgoOrders,
  type AlgoOrderResult,
  type FuturesPositionRisk,
} from '../binance/rest-trade';
import { floorToStep, roundToTick } from '../mapping/precision';
import type { InstrumentPrecision } from '../mapping/precision';
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
  fundingFeeEst: number;
  /** Margin type: ISOLATED (default) or CROSSED. */
  marginType?: 'ISOLATED' | 'CROSSED';
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

  constructor(private readonly opts: BinanceAdapterOptions) {
    this.log = opts.log ?? ((msg, meta) => process.stdout.write(`${msg} ${JSON.stringify(meta ?? {})}\n`));
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
    // Quantity is already stepped by RiskManager, but re-floor defensively.
    const qty = floorToStep(req.quantity, stepSize);
    if (qty <= 0) {
      return this.failResult(req.referencePrice, req.quantity, startedAt, 'quantity below stepSize');
    }

    let entryOrder;
    try {
      entryOrder = await placeOrder(this.opts.client, {
        symbol: sym,
        side: entrySide,
        type: 'MARKET',
        quantity: qty,
        newOrderRespType: 'RESULT',
      });
    } catch (e) {
      return this.failResult(req.referencePrice, qty, startedAt, (e as Error).message);
    }

    const fillPrice = Number(entryOrder.avgPrice) || req.referencePrice;
    const latencyMs = Date.now() - startedAt;
    const entryFee = fillPrice * qty * this.opts.takerFee;

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
      });
      trade.tp2StrategyId = r.strategyId;
      this.algoIdToInternal.set(r.strategyId, trade.internalId);
    } catch (e) {
      this.log('binance_tp2_warn', { sym, err: (e as Error).message });
    }

    // SL: close full remaining position.
    try {
      const r = await placeAlgoOrder(this.opts.client, {
        symbol: sym,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: roundToTick(sl, tickSize),
        closePosition: true,
        workingType: 'MARK_PRICE',
        timeInForce: 'GTE_GTC',
      });
      trade.slStrategyId = r.strategyId;
      this.algoIdToInternal.set(r.strategyId, trade.internalId);
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
