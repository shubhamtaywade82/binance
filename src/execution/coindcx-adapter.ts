import { randomUUID } from 'crypto';
import type { CoinDcxFuturesClient } from '../coindcx/futures-client';
import type {
  CloseReason,
  ClosedPosition,
  ExecutionAdapter,
  Fill,
  OrderRequest,
  OrderResult,
} from './types';

export interface CoinDcxAdapterOptions {
  client: CoinDcxFuturesClient;
  marginCurrency: string;
  takerFee: number;
  fundingFeeEst: number;
  /** If true, skip leverage update call (already set). */
  skipLeverageUpdate?: boolean;
}

interface OpenLiveOrder {
  orderId: string;
  side: 'LONG' | 'SHORT';
  pair: string;
  leverage: number;
  entryPrice: number;
  quantity: number;
  openedAt: number;
  entryFeeUsdt: number;
}

export class CoinDcxExecutionAdapter implements ExecutionAdapter {
  readonly name = 'live' as const;
  private orders = new Map<string, OpenLiveOrder>();

  constructor(private readonly opts: CoinDcxAdapterOptions) {}

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    if (!this.opts.skipLeverageUpdate) {
      try {
        await this.opts.client.updatePositionLeverage({ pair: req.pair, leverage: req.leverage });
      } catch {
        // best-effort: continue to order
      }
    }
    const startedAt = Date.now();
    try {
      await this.opts.client.createFuturesOrder({
        pair: req.pair,
        side: req.side === 'LONG' ? 'buy' : 'sell',
        order_type: 'market',
        price: null,
        stop_price: null,
        total_quantity: req.quantity,
        notification: 'no_notification',
        margin_currency_short_name: req.marginCurrency || this.opts.marginCurrency,
      });
    } catch (e) {
      return {
        ok: false,
        orderId: randomUUID(),
        fill: {
          price: req.referencePrice,
          quantity: req.quantity,
          feeUsdt: 0,
          slippageUsdt: 0,
          latencyMs: Date.now() - startedAt,
          timestamp: Date.now(),
        },
        error: (e as Error).message,
      };
    }

    if (req.takeProfit !== undefined && req.stopLoss !== undefined) {
      try {
        await this.opts.client.createFuturesTpSlOrders({
          pair: req.pair,
          side: req.side === 'LONG' ? 'sell' : 'buy',
          total_quantity: req.quantity,
          take_profit_price: req.takeProfit,
          stop_loss_price: req.stopLoss,
          margin_currency_short_name: req.marginCurrency || this.opts.marginCurrency,
        });
      } catch {
        // best-effort
      }
    }

    const orderId = randomUUID();
    const entryNotional = req.referencePrice * req.quantity;
    const entryFee = entryNotional * this.opts.takerFee;
    const fill: Fill = {
      price: req.referencePrice,
      quantity: req.quantity,
      feeUsdt: entryFee,
      slippageUsdt: 0,
      latencyMs: Date.now() - startedAt,
      timestamp: Date.now(),
    };
    this.orders.set(orderId, {
      orderId,
      side: req.side,
      pair: req.pair,
      leverage: req.leverage,
      entryPrice: req.referencePrice,
      quantity: req.quantity,
      openedAt: Date.now(),
      entryFeeUsdt: entryFee,
    });
    return { ok: true, orderId, fill };
  }

  async closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
    const open = this.orders.get(orderId);
    if (!open) throw new Error(`live_close_unknown_order:${orderId}`);
    let exitPrice = open.entryPrice;
    try {
      await this.opts.client.exitFuturesPosition({ pair: open.pair, quantity: open.quantity });
    } catch {
      // best-effort
    }
    try {
      const data = (await this.opts.client.getFuturesPositionByPair(open.pair)) as
        | Array<Record<string, unknown>>
        | Record<string, unknown>
        | null;
      const arr = Array.isArray(data) ? data : data ? [data] : [];
      const last = arr[0];
      if (last) {
        const candidates = ['avg_close_price', 'avgClosePrice', 'mark_price', 'markPrice', 'last_price'];
        for (const k of candidates) {
          const v = Number((last as Record<string, unknown>)[k]);
          if (Number.isFinite(v) && v > 0) {
            exitPrice = v;
            break;
          }
        }
      }
    } catch {
      // keep entry price as fallback
    }

    const sideMul = open.side === 'LONG' ? 1 : -1;
    const gross = (exitPrice - open.entryPrice) * open.quantity * sideMul;
    const exitNotional = exitPrice * open.quantity;
    const exitFee = exitNotional * this.opts.takerFee;
    const fees = open.entryFeeUsdt + exitFee;
    const funding = open.entryPrice * open.quantity * this.opts.fundingFeeEst;
    const net = gross - fees - funding;
    const closed: ClosedPosition = {
      orderId,
      side: open.side,
      leverage: open.leverage,
      entryPrice: open.entryPrice,
      exitPrice,
      quantity: open.quantity,
      reason,
      grossUsdt: gross,
      feesUsdt: fees,
      fundingUsdt: funding,
      netUsdt: net,
      openedAt: open.openedAt,
      closedAt: Date.now(),
    };
    this.orders.delete(orderId);
    return closed;
  }

  async setLeverage(pair: string, lev: number): Promise<void> {
    await this.opts.client.updatePositionLeverage({ pair, leverage: lev });
  }
}
