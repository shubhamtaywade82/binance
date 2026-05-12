import { randomUUID } from 'node:crypto';
import type { BinanceRestClient } from '../binance/rest-client';
import {
  setLeverage,
  setMarginType,
  placeOrder,
  cancelAllOrders,
  getPositionRisk,
} from '../binance/rest-trade';
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
  /** Log function for order events. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

interface OpenLiveTrade {
  internalId: string;
  binanceOrderId: number;
  /** TP order IDs — cancel on manual close. */
  tpOrderIds: number[];
  /** SL order ID — cancel on manual close. */
  slOrderId: number | null;
  side: 'LONG' | 'SHORT';
  symbol: string;
  entryPrice: number;
  quantity: number;
  openedAt: number;
  entryFeeUsdt: number;
}

/**
 * Live execution adapter for Binance USD-M Futures.
 *
 * Order flow per trade:
 *   1. `POST /fapi/v1/leverage` — set leverage
 *   2. `POST /fapi/v1/marginType` — ISOLATED (idempotent)
 *   3. `POST /fapi/v1/order` MARKET entry
 *   4. `POST /fapi/v1/order` TAKE_PROFIT_MARKET TP1 (60% at 0.9% move)
 *   5. `POST /fapi/v1/order` TAKE_PROFIT_MARKET TP2 (40% at 1.5% move)
 *   6. `POST /fapi/v1/order` STOP_MARKET SL
 *
 * Close: cancel open TP/SL, then MARKET reduceOnly in opposite direction.
 */
export class BinanceLiveExecutionAdapter implements ExecutionAdapter {
  readonly name = 'live' as const;
  private trades = new Map<string, OpenLiveTrade>();
  private lastMark = 0;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly opts: BinanceAdapterOptions) {
    this.log = opts.log ?? ((msg, meta) => process.stdout.write(`${msg} ${JSON.stringify(meta ?? {})}\n`));
  }

  onMark(_symbol: string, markPrice: number): void {
    this.lastMark = markPrice;
  }

  async setLeverage(pair: string, lev: number): Promise<void> {
    const sym = this.resolveSymbol(pair);
    await setLeverage(this.opts.client, sym, lev);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const sym = this.resolveSymbol(req.pair);
    const startedAt = Date.now();

    // 1. Configure leverage + margin type (idempotent).
    await this.setupSymbol(sym, req.leverage);

    const entrySide = req.side === 'LONG' ? 'BUY' : 'SELL';
    const qty = req.quantity;

    // 2. Market entry.
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
    const notional = fillPrice * qty;
    const entryFee = notional * this.opts.takerFee;

    const internalId = randomUUID();
    const trade: OpenLiveTrade = {
      internalId,
      binanceOrderId: entryOrder.orderId,
      tpOrderIds: [],
      slOrderId: null,
      side: req.side,
      symbol: sym,
      entryPrice: fillPrice,
      quantity: qty,
      openedAt: Date.now(),
      entryFeeUsdt: entryFee,
    };

    // 3. Attach TP + SL orders.
    const closeSide = req.side === 'LONG' ? 'SELL' : 'BUY';
    await this.attachTpSl(trade, closeSide, fillPrice, req.takeProfit, req.stopLoss, qty);

    this.trades.set(internalId, trade);
    this.log('binance_order_placed', {
      id: internalId,
      binanceOrderId: entryOrder.orderId,
      side: req.side,
      fillPrice,
      qty,
      tp: req.takeProfit,
      sl: req.stopLoss,
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

  async closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
    const trade = this.trades.get(orderId);
    if (!trade) throw new Error(`binance_close_unknown:${orderId}`);

    const closeSide = trade.side === 'LONG' ? 'SELL' : 'BUY';
    let exitPrice = this.lastMark || trade.entryPrice;

    // Cancel any remaining TP / SL orders.
    try {
      await cancelAllOrders(this.opts.client, trade.symbol);
    } catch (e) {
      this.log('binance_cancel_orders_warn', { id: orderId, err: (e as Error).message });
    }

    // Market close (reduceOnly).
    try {
      const closeOrder = await placeOrder(this.opts.client, {
        symbol: trade.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: trade.quantity,
        reduceOnly: true,
        newOrderRespType: 'RESULT',
      });
      const avg = Number(closeOrder.avgPrice);
      if (Number.isFinite(avg) && avg > 0) exitPrice = avg;
    } catch {
      // If reduceOnly fails (position already closed by TP/SL), fetch from position risk.
      const positions = await getPositionRisk(this.opts.client, trade.symbol).catch(() => []);
      const pos = positions.find((p) => p.symbol === trade.symbol);
      if (pos) {
        const mp = Number(pos.markPrice);
        if (Number.isFinite(mp) && mp > 0) exitPrice = mp;
      }
    }

    const sideMul = trade.side === 'LONG' ? 1 : -1;
    const gross = (exitPrice - trade.entryPrice) * trade.quantity * sideMul;
    const exitFee = exitPrice * trade.quantity * this.opts.takerFee;
    const funding = trade.entryPrice * trade.quantity * this.opts.fundingFeeEst;
    const net = gross - trade.entryFeeUsdt - exitFee - funding;

    this.trades.delete(orderId);
    this.log('binance_position_closed', { id: orderId, reason, exitPrice, gross, net });

    return {
      orderId,
      side: trade.side,
      entryPrice: trade.entryPrice,
      exitPrice,
      quantity: trade.quantity,
      reason,
      grossUsdt: gross,
      feesUsdt: trade.entryFeeUsdt + exitFee,
      fundingUsdt: funding,
      netUsdt: net,
      openedAt: trade.openedAt,
      closedAt: Date.now(),
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private resolveSymbol(_pair: string): string {
    return this.opts.symbol.toUpperCase();
  }

  private async setupSymbol(sym: string, leverage: number): Promise<void> {
    try {
      await setLeverage(this.opts.client, sym, leverage);
    } catch (e) {
      this.log('binance_set_leverage_warn', { sym, leverage, err: (e as Error).message });
    }
    try {
      await setMarginType(this.opts.client, sym, this.opts.marginType ?? 'ISOLATED');
    } catch (e) {
      this.log('binance_set_margin_warn', { sym, err: (e as Error).message });
    }
  }

  /**
   * Attach TP1 (60% at 0.9%), TP2 (40% at 1.5%), and SL.
   * Falls back to a single TP at 1.5% if explicit values are provided.
   */
  private async attachTpSl(
    trade: OpenLiveTrade,
    closeSide: 'BUY' | 'SELL',
    entryPrice: number,
    tpPrice: number | undefined,
    slPrice: number | undefined,
    qty: number,
  ): Promise<void> {
    const sym = trade.symbol;

    // Determine effective TP and SL prices.
    const tp = tpPrice ?? (trade.side === 'LONG' ? entryPrice * 1.015 : entryPrice * 0.985);
    const sl = slPrice ?? (trade.side === 'LONG' ? entryPrice * 0.99 : entryPrice * 1.01);

    // TP1: 60% quantity at 0.9% move.
    const tp1Price = trade.side === 'LONG' ? entryPrice * 1.009 : entryPrice * 0.991;
    const tp1Qty = parseFloat((qty * 0.6).toFixed(3));
    const tp2Qty = parseFloat((qty * 0.4).toFixed(3));

    try {
      const tp1 = await placeOrder(this.opts.client, {
        symbol: sym,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: parseFloat(tp1Price.toFixed(2)),
        quantity: tp1Qty,
        workingType: 'MARK_PRICE',
        reduceOnly: true,
        timeInForce: 'GTE_GTC',
      });
      trade.tpOrderIds.push(tp1.orderId);
    } catch (e) {
      this.log('binance_tp1_warn', { sym, err: (e as Error).message });
    }

    try {
      const tp2 = await placeOrder(this.opts.client, {
        symbol: sym,
        side: closeSide,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: parseFloat(tp.toFixed(2)),
        quantity: tp2Qty,
        workingType: 'MARK_PRICE',
        reduceOnly: true,
        timeInForce: 'GTE_GTC',
      });
      trade.tpOrderIds.push(tp2.orderId);
    } catch (e) {
      this.log('binance_tp2_warn', { sym, err: (e as Error).message });
    }

    try {
      const slOrder = await placeOrder(this.opts.client, {
        symbol: sym,
        side: closeSide,
        type: 'STOP_MARKET',
        stopPrice: parseFloat(sl.toFixed(2)),
        closePosition: true,
        workingType: 'MARK_PRICE',
        timeInForce: 'GTE_GTC',
      });
      trade.slOrderId = slOrder.orderId;
    } catch (e) {
      this.log('binance_sl_warn', { sym, err: (e as Error).message });
    }
  }

  private failResult(refPrice: number, qty: number, startedAt: number, error: string): OrderResult {
    return {
      ok: false,
      orderId: randomUUID(),
      fill: {
        price: refPrice,
        quantity: qty,
        feeUsdt: 0,
        slippageUsdt: 0,
        latencyMs: Date.now() - startedAt,
        timestamp: Date.now(),
      },
      error,
    };
  }
}
