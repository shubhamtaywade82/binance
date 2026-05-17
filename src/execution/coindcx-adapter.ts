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
  private lastMarkBySymbol = new Map<string, number>();

  constructor(private readonly opts: CoinDcxAdapterOptions) {}

  /** Live mark price hook — called by MarkPriceBridge for every market.mark event. */
  onMark(symbol: string, markPrice: number): void {
    if (!Number.isFinite(markPrice) || markPrice <= 0) return;
    this.lastMarkBySymbol.set(symbol.toUpperCase(), markPrice);
  }

  /** Quote mid for a symbol — fallback when REST snapshot lacks a mark price. */
  public latestMark(symbol: string): number | undefined {
    return this.lastMarkBySymbol.get(symbol.toUpperCase());
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    // Opposite-side guard: if we have a same-pair opposite-side position,
    // REJECT instead of internally flipping. The event-bus RiskEngine should
    // have blocked this upstream; reaching here = state desync. Silently
    // flipping doubles fees + skips the close event downstream consumers
    // (trail, ladder, risk) need.
    for (const [id, p] of this.orders.entries()) {
      if (p.pair === req.pair && p.side !== req.side) {
        return {
          ok: false,
          orderId: id,
          fill: {
            price: req.referencePrice,
            quantity: req.quantity,
            feeUsdt: 0,
            slippageUsdt: 0,
            latencyMs: 0,
            timestamp: Date.now(),
          },
          error: 'opposite_side_open_position_no_internal_reversal',
        };
      }
    }

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

  private onTradeCloseCb?: (trade: ClosedPosition) => void;

  async closePosition(orderId: string, reason: CloseReason, quantity?: number): Promise<ClosedPosition> {
    const open = this.orders.get(orderId);
    if (!open) throw new Error(`live_close_unknown_order:${orderId}`);
    const isPartial = quantity !== undefined && quantity < open.quantity;
    const qtyToClose = isPartial ? quantity : open.quantity;
    let exitPrice = open.entryPrice;
    try {
      await this.opts.client.exitFuturesPosition({ pair: open.pair, quantity: qtyToClose });
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
    if (exitPrice === open.entryPrice) {
      // REST didn't give us a fresh price — fall back to last live mark.
      const mark = this.latestMark(open.pair) ?? this.latestMark(open.pair.replace(/^B-/, '').replace('_', ''));
      if (mark && mark > 0) exitPrice = mark;
    }

    const sideMul = open.side === 'LONG' ? 1 : -1;
    const gross = (exitPrice - open.entryPrice) * qtyToClose * sideMul;
    const exitNotional = exitPrice * qtyToClose;
    const exitFee = exitNotional * this.opts.takerFee;
    const entryFeeAttributed = open.entryFeeUsdt * (qtyToClose / open.quantity);
    const fees = entryFeeAttributed + exitFee;
    const funding = open.entryPrice * qtyToClose * this.opts.fundingFeeEst;
    const net = gross - fees - funding;
    const closed: ClosedPosition = {
      orderId,
      symbol: open.pair,
      side: open.side,
      leverage: open.leverage,
      entryPrice: open.entryPrice,
      exitPrice,
      quantity: qtyToClose,
      reason,
      grossUsdt: gross,
      feesUsdt: fees,
      fundingUsdt: funding,
      netUsdt: net,
      openedAt: open.openedAt,
      closedAt: Date.now(),
    };

    if (isPartial) {
      open.quantity -= qtyToClose;
      open.entryFeeUsdt -= entryFeeAttributed;
    } else {
      this.orders.delete(orderId);
    }

    this.onTradeCloseCb?.(closed);
    return closed;
  }

  async setLeverage(pair: string, lev: number): Promise<void> {
    await this.opts.client.updatePositionLeverage({ pair, leverage: lev });
  }

  async getWalletState(): Promise<any> {
    try {
      const [accountDetails, wallets] = await Promise.allSettled([
        this.opts.client.getFuturesAccountDetails(),
        this.opts.client.getFuturesWallets(),
      ]);

      const account = accountDetails.status === 'fulfilled' ? (accountDetails.value as Record<string, any>) : {};
      const walletsArr = wallets.status === 'fulfilled' ? (wallets.value as any[]) : [];
      const usdtWallet = (walletsArr || []).find((w: any) => w.currency_short_name === 'USDT') || {};
      const inrWallet = (walletsArr || []).find((w: any) => w.currency_short_name === 'INR') || {};

      const balanceUsdt = Number(usdtWallet.balance) || Number(account.total_wallet_balance) || (Number(account.total_account_equity) - Number(account.pnl)) || 0;
      const availableUsdt = Number(account.available_balance_cross) || Number(usdtWallet.balance) || 0;
      const usedMarginUsdt = Number(usdtWallet.locked_balance) || (balanceUsdt - availableUsdt) || 0;
      const unrealizedPnlUsdt = Number(account.pnl) || 0;
      const equityUsdt = Number(account.total_account_equity) || (balanceUsdt + unrealizedPnlUsdt) || 0;

      const balanceInr = Number(inrWallet.balance) || 0;
      const availableInr = Number(inrWallet.balance) - Number(inrWallet.locked_balance ?? 0) || balanceInr;
      const usedMarginInr = Number(inrWallet.locked_balance) || 0;

      // Aggregate all currency wallets so the UI can show all balances.
      const allBalances = (walletsArr || []).map((w: any) => ({
        currency: w.currency_short_name,
        balance: Number(w.balance) || 0,
        locked: Number(w.locked_balance) || 0,
      }));

      return {
        balanceUsdt,
        availableUsdt,
        usedMarginUsdt,
        unrealizedPnlUsdt,
        realizedPnlUsdt: 0,
        equityUsdt,
        balanceInr,
        availableInr,
        usedMarginInr,
        allBalances,
        updatedAt: Date.now(),
      };
    } catch {
      return {
        balanceUsdt: 0,
        availableUsdt: 0,
        usedMarginUsdt: 0,
        unrealizedPnlUsdt: 0,
        realizedPnlUsdt: 0,
        equityUsdt: 0,
        balanceInr: 0,
        availableInr: 0,
        usedMarginInr: 0,
        allBalances: [] as Array<{ currency: string; balance: number; locked: number }>,
        updatedAt: Date.now(),
      };
    }
  }

  async getOpenPositions(): Promise<any[]> {
    try {
      const data = (await this.opts.client.getFuturesPositions()) as any[];
      return (data || []).map((p) => ({
        orderId: p.position_id,
        symbol: p.pair,
        side: p.side === 'buy' ? 'LONG' : 'SHORT',
        entryPrice: p.avg_price,
        quantity: p.active_pos,
        leverage: p.leverage,
        marginUsdt: p.user_margin,
        liqPrice: p.liquidation_price,
        openedAt: p.created_at || Date.now(),
        unrealizedUsdt: p.pnl,
        mode: 'live',
      }));
    } catch {
      return [];
    }
  }

  setOnTradeClose(cb: (trade: ClosedPosition) => void): void {
    this.onTradeCloseCb = cb;
  }
}

