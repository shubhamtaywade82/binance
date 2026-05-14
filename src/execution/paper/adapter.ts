import { randomUUID } from 'crypto';
import type {
  CloseReason,
  ClosedPosition,
  ExecutionAdapter,
  Fill,
  OrderRequest,
  OrderResult,
} from '../types';
import { PaperWallet } from './wallet';
import { SlippageEngine } from './slippage';
import { LiquidationEngine } from './liquidation';
import { computeFee } from './fees';
import { FundingEngine } from './funding';
import { Ledger, type OpenSnapshot } from './ledger';
import { BookTickerFeed } from './book-ticker-feed';
import type { PgWriter } from '../../persistence/pg-writer';

export interface PaperAdapterOptions {
  wallet: PaperWallet;
  book: BookTickerFeed;
  liquidation: LiquidationEngine;
  funding: FundingEngine;
  ledger: Ledger;
  takerFee: number;
  makerFee: number;
  baseSlippageBps: number;
  latencyMs: number;
  equitySnapshotMs: number;
  symbolFor: (pair: string) => string;
  partialFills?: boolean;
  maxSlippageBps?: number;
  onTradeClose?: (trade: ClosedPosition) => void;
  pgWriter?: PgWriter;
}

interface OpenPaperPosition {
  orderId: string;
  pair: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  leverage: number;
  marginUsdt: number;
  entryFeeUsdt: number;
  takeProfit?: number;
  stopLoss?: number;
  liqPrice: number;
  openedAt: number;
}

export class PaperExecutionAdapter implements ExecutionAdapter {
  readonly name = 'paper' as const;
  private positions = new Map<string, OpenPaperPosition>();
  private unrealizedByOrder = new Map<string, number>();
  private lastSnapshotTs = 0;

  constructor(private readonly opts: PaperAdapterOptions) {}

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const symbol = this.opts.symbolFor(req.pair).toUpperCase();
    if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs);
    const tick = this.opts.book.latest(symbol);
    const lastTrade = this.opts.book.lastTrade(symbol);
    const refMid = tick ? (tick.bestAsk + tick.bestBid) / 2 : lastTrade ?? req.referencePrice;
    const spread = tick ? tick.spread : Math.max(refMid * 0.0001, 0);

    const topBookQty = (this.opts.partialFills && tick)
      ? (req.side === 'LONG' ? tick.bestAskQty : tick.bestBidQty)
      : undefined;

    const slip = SlippageEngine.priceImpactUsdt({
      side: req.side,
      quantity: req.quantity,
      spread,
      volatilityPct: 0,
      baseSlippageBps: this.opts.baseSlippageBps,
      topBookQty,
      midPrice: refMid,
      maxSlippageBps: this.opts.maxSlippageBps,
    });

    const baseAsk = tick ? tick.bestAsk : refMid;
    const baseBid = tick ? tick.bestBid : refMid;
    const fillPrice = req.side === 'LONG' ? baseAsk + slip : baseBid - slip;
    const notional = fillPrice * req.quantity;
    const margin = notional / req.leverage;
    const fee = computeFee(notional, true, this.opts.takerFee, this.opts.makerFee);

    if (!this.opts.wallet.reserveMargin(margin + fee)) {
      const orderId = randomUUID();
      const failFill: Fill = {
        price: fillPrice,
        quantity: req.quantity,
        feeUsdt: 0,
        slippageUsdt: slip * req.quantity,
        latencyMs: this.opts.latencyMs,
        timestamp: Date.now(),
      };
      return { ok: false, orderId, fill: failFill, error: 'insufficient_margin' };
    }

    const orderId = randomUUID();
    const liqPrice = this.opts.liquidation.track(orderId, req.side, fillPrice, req.leverage);
    const openedAt = Date.now();
    const pos: OpenPaperPosition = {
      orderId,
      pair: req.pair,
      symbol,
      side: req.side,
      entryPrice: fillPrice,
      quantity: req.quantity,
      leverage: req.leverage,
      marginUsdt: margin,
      entryFeeUsdt: fee,
      takeProfit: req.takeProfit,
      stopLoss: req.stopLoss,
      liqPrice,
      openedAt,
    };
    this.positions.set(orderId, pos);

    this.opts.pgWriter?.upsertPosition({
      orderId, symbol, side: req.side, quantity: req.quantity,
      entryPrice: fillPrice, leverage: req.leverage,
      marginUsdt: margin, liqPrice, openedAt,
    }).catch(() => {});

    this.opts.pgWriter?.writeOrder({
      orderId, symbol, side: req.side, quantity: req.quantity,
      price: fillPrice, status: 'FILLED',
      fillPrice, feeUsdt: fee, slippageUsdt: slip * req.quantity,
      latencyMs: this.opts.latencyMs,
    }).catch(() => {});

    this.opts.funding.trackPosition({
      positionId: orderId,
      symbol,
      side: req.side,
      notional: () => pos.entryPrice * pos.quantity,
    });

    const fill: Fill = {
      price: fillPrice,
      quantity: req.quantity,
      feeUsdt: fee,
      slippageUsdt: slip * req.quantity,
      latencyMs: this.opts.latencyMs,
      timestamp: openedAt,
    };
    return { ok: true, orderId, fill };
  }

  onMark(symbol: string, markPrice: number): void {
    const symU = symbol.toUpperCase();
    let totalUnrealized = 0;
    for (const pos of this.positions.values()) {
      if (pos.symbol !== symU) continue;
      const sideMul = pos.side === 'LONG' ? 1 : -1;
      const unrealized = (markPrice - pos.entryPrice) * pos.quantity * sideMul;
      this.unrealizedByOrder.set(pos.orderId, unrealized);
      totalUnrealized += unrealized;
    }
    this.opts.wallet.setUnrealized(totalUnrealized);

    const triggered = this.opts.liquidation.triggered(markPrice);
    for (const t of triggered) {
      const pos = this.positions.get(t.orderId);
      if (!pos || pos.symbol !== symU) continue;
      void this.closePosition(t.orderId, 'LIQUIDATION');
    }

    const now = Date.now();
    if (now - this.lastSnapshotTs >= this.opts.equitySnapshotMs) {
      this.lastSnapshotTs = now;
      const open: OpenSnapshot[] = Array.from(this.positions.values()).map((p) => ({
        orderId: p.orderId,
        side: p.side,
        entryPrice: p.entryPrice,
        quantity: p.quantity,
        unrealizedUsdt: ((markPrice - p.entryPrice) * p.quantity) * (p.side === 'LONG' ? 1 : -1),
      }));
      this.opts.ledger.snapshotEquity(this.opts.wallet.state(), open);

      this.opts.pgWriter?.writeEquitySnapshot(
        this.opts.wallet.state(),
        0,
        this.positions.size,
      ).catch(() => {});

      this.opts.wallet.flushToDisk();
    }
  }

  async closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
    const pos = this.positions.get(orderId);
    if (!pos) throw new Error(`paper_close_unknown_order:${orderId}`);
    if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs);
    const tick = this.opts.book.latest(pos.symbol);
    const lastTrade = this.opts.book.lastTrade(pos.symbol);
    const refMid = tick ? (tick.bestAsk + tick.bestBid) / 2 : lastTrade ?? pos.entryPrice;
    const spread = tick ? tick.spread : Math.max(refMid * 0.0001, 0);
    const topBookQty = (this.opts.partialFills && tick)
      ? (pos.side === 'LONG' ? tick.bestBidQty : tick.bestAskQty)
      : undefined;

    const slip = SlippageEngine.priceImpactUsdt({
      side: pos.side,
      quantity: pos.quantity,
      spread,
      volatilityPct: 0,
      baseSlippageBps: this.opts.baseSlippageBps,
      topBookQty,
      midPrice: refMid,
      maxSlippageBps: this.opts.maxSlippageBps,
    });

    const baseAsk = tick ? tick.bestAsk : refMid;
    const baseBid = tick ? tick.bestBid : refMid;
    const exitPrice = pos.side === 'LONG' ? baseBid - slip : baseAsk + slip;
    const sideMul = pos.side === 'LONG' ? 1 : -1;
    const gross = (exitPrice - pos.entryPrice) * pos.quantity * sideMul;
    const exitNotional = exitPrice * pos.quantity;
    const exitFee = computeFee(exitNotional, true, this.opts.takerFee, this.opts.makerFee);
    const totalFees = pos.entryFeeUsdt + exitFee;
    const funding = this.opts.funding.accruedFor(orderId);
    const net = gross - totalFees - funding;

    this.opts.wallet.releaseMargin(pos.marginUsdt + pos.entryFeeUsdt);
    this.opts.wallet.applyRealized(net);
    this.opts.wallet.setUnrealized(0);
    this.opts.liquidation.untrack(orderId);
    this.opts.funding.untrackPosition(orderId);
    this.positions.delete(orderId);
    this.unrealizedByOrder.delete(orderId);

    const closed: ClosedPosition = {
      orderId,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: pos.quantity,
      reason,
      grossUsdt: gross,
      feesUsdt: totalFees,
      fundingUsdt: funding,
      netUsdt: net,
      openedAt: pos.openedAt,
      closedAt: Date.now(),
    };
    this.opts.ledger.appendTrade(closed);
    this.opts.onTradeClose?.(closed);

    this.opts.pgWriter?.writeTrade(closed, pos.symbol).catch(() => {});
    this.opts.pgWriter?.removePosition(orderId).catch(() => {});
    this.opts.pgWriter?.writeOrder({
      orderId, symbol: pos.symbol, side: pos.side, quantity: pos.quantity,
      price: exitPrice, status: 'CLOSED',
      fillPrice: exitPrice, feeUsdt: exitFee,
      slippageUsdt: slip * pos.quantity, latencyMs: this.opts.latencyMs,
    }).catch(() => {});

    this.opts.wallet.flushToDisk();
    return closed;
  }

  getOpenPositions(): Array<{
    orderId: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    quantity: number;
    leverage: number;
    marginUsdt: number;
    liqPrice: number;
    openedAt: number;
    unrealizedUsdt: number;
  }> {
    return Array.from(this.positions.values()).map((p) => ({
      orderId: p.orderId,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      quantity: p.quantity,
      leverage: p.leverage,
      marginUsdt: p.marginUsdt,
      liqPrice: p.liqPrice,
      openedAt: p.openedAt,
      unrealizedUsdt: this.unrealizedByOrder.get(p.orderId) ?? 0,
    }));
  }

  getWalletState() {
    return this.opts.wallet.state();
  }

  setOnTradeClose(cb: (trade: ClosedPosition) => void): void {
    this.opts.onTradeClose = cb;
  }

  async setLeverage(_pair: string, _lev: number): Promise<void> {
    return;
  }
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => setTimeout(r, ms));
}
