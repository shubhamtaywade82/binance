import fs from 'fs';
import path from 'path';
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
import type { RedisPaperStateStore } from '../../persistence/redis-paper-state';

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
  /** Optional FX rate provider for INR-aware equity snapshots. */
  fxRate?: { getInrPerUsdt(): number };
  /** Optional Redis hot cache. When set, wallet + positions + equity stream are mirrored to Redis. */
  redisState?: RedisPaperStateStore;
  /**
   * Throttle ratio for JSONL equity writes.
   *   1  → every snapshot (default, legacy behaviour, equity.jsonl grows fast)
   *   12 → every 12th snapshot (≈ 60s when equitySnapshotMs=5000)
   *   0  → disable JSONL equity writes entirely (Redis stream becomes the source of truth)
   */
  equityJsonlEveryN?: number;
  /**
   * Disk path for open-position persistence. Without this, the in-memory
   * `positions` map is lost on every restart while wallet.json survives —
   * MAX_OPEN_POSITIONS/MAX_OPEN_SYMBOLS gates then start from 0 even though
   * the dashboard (Redis) still shows the prior positions. Result: caps
   * silently exceeded across restarts.
   */
  positionsPath?: string;
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
  private snapshotCount = 0;

  constructor(private readonly opts: PaperAdapterOptions) {
    this.loadPositionsFromDisk();
  }

  /**
   * Restore open positions from disk. Re-tracks liquidation + funding for
   * each restored position and rebuilds wallet.usedMargin so cap accounting
   * resumes accurately. Wallet intentionally clears usedMargin on its own
   * loadFromDisk (see wallet.ts); we re-apply it here from the authoritative
   * positions snapshot.
   */
  private loadPositionsFromDisk(): void {
    const p = this.opts.positionsPath;
    if (!p || !fs.existsSync(p)) return;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const arr = JSON.parse(raw) as OpenPaperPosition[];
      if (!Array.isArray(arr)) return;
      for (const pos of arr) {
        this.positions.set(pos.orderId, pos);
        // Re-track ancillary engines so liquidation/funding work post-restart.
        this.opts.liquidation.track(pos.orderId, pos.side, pos.entryPrice, pos.leverage);
        this.opts.funding.trackPosition({
          positionId: pos.orderId,
          symbol: pos.symbol,
          side: pos.side,
          notional: () => pos.entryPrice * pos.quantity,
        });
        // Re-reserve margin so subsequent reserveMargin checks reflect reality.
        this.opts.wallet.reserveMargin(pos.marginUsdt);
      }
    } catch {
      // Corrupt snapshot — ignore; positions start empty.
    }
  }

  private flushPositionsToDisk(): void {
    const p = this.opts.positionsPath;
    if (!p) return;
    try {
      const dir = path.dirname(p);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Array.from(this.positions.values()), null, 2));
      fs.renameSync(tmp, p);
    } catch {
      // Disk full / permissions — best-effort.
    }
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const symbol = this.opts.symbolFor(req.pair).toUpperCase();

    // Check for existing position to allow pyramiding or reversal
    for (const [id, p] of this.positions.entries()) {
      if (p.symbol === symbol) {
        if (p.side === req.side) {
          // SAME SIDE: Pyramiding — add to existing position
          if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs);
          const fill = await this.calculateFill(req, symbol);

          const addedMargin = (fill.price * fill.quantity) / p.leverage;
          const totalRequired = addedMargin + fill.feeUsdt;

          if (!this.opts.wallet.reserveMargin(totalRequired)) {
            return { ok: false, orderId: id, fill, error: 'insufficient_margin' };
          }

          const newQty = p.quantity + fill.quantity;
          const newNotional = (p.entryPrice * p.quantity) + (fill.price * fill.quantity);
          const newEntry = newNotional / newQty;

          p.entryPrice = newEntry;
          p.quantity = newQty;
          p.marginUsdt += addedMargin;
          p.entryFeeUsdt += fill.feeUsdt;

          this.positions.set(id, p);
          this.flushPositionsToDisk();
          void this.opts.redisState?.upsertPosition(id, this.snapshotPosition(p));
          void this.opts.redisState?.setWallet(this.opts.wallet.state());
          void this.opts.redisState?.publishUpdate('position', { event: 'update', orderId: id, symbol });

          return { ok: true, orderId: id, fill };
        }
        // Opposite side: REJECT. The event-bus path (RiskEngine
        // OPPOSITE_SIDE_OPEN_POSITION) is supposed to block this upstream.
        // Reaching the adapter means state desync — silently flipping would
        // double the risk and starve trailing/structure exits of the close
        // event they expect. Force callers to close-then-reopen explicitly.
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

    if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs);
    const fill = await this.calculateFill(req, symbol);

    const notional = fill.price * req.quantity;
    const margin = notional / req.leverage;

    if (!this.opts.wallet.reserveMargin(margin + fill.feeUsdt)) {
      const orderId = randomUUID();
      return { ok: false, orderId, fill, error: 'insufficient_margin' };
    }

    const orderId = randomUUID();
    const liqPrice = this.opts.liquidation.track(orderId, req.side, fill.price, req.leverage);
    const openedAt = Date.now();
    const pos: OpenPaperPosition = {
      orderId,
      pair: req.pair,
      symbol,
      side: req.side,
      entryPrice: fill.price,
      quantity: req.quantity,
      leverage: req.leverage,
      marginUsdt: margin,
      entryFeeUsdt: fill.feeUsdt,
      takeProfit: req.takeProfit,
      stopLoss: req.stopLoss,
      liqPrice,
      openedAt,
    };
    this.positions.set(orderId, pos);
    this.flushPositionsToDisk();
    void this.opts.redisState?.upsertPosition(orderId, this.snapshotPosition(pos));
    void this.opts.redisState?.setWallet(this.opts.wallet.state());
    void this.opts.redisState?.publishUpdate('position', { event: 'open', orderId, symbol });

    this.opts.funding.trackPosition({
      positionId: orderId,
      symbol,
      side: req.side,
      notional: () => pos.entryPrice * pos.quantity,
    });

    return { ok: true, orderId, fill };
  }

  private async calculateFill(req: OrderRequest, symbol: string): Promise<Fill> {
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
    const fee = computeFee(notional, true, this.opts.takerFee, this.opts.makerFee);

    return {
      price: fillPrice,
      quantity: req.quantity,
      feeUsdt: fee,
      slippageUsdt: slip * req.quantity,
      latencyMs: this.opts.latencyMs,
      timestamp: Date.now(),
    };
  }

  /** Latest mark per symbol — used to refresh unrealized for other symbols' positions. */
  private lastMarkBySymbol = new Map<string, number>();

  onMark(symbol: string, markPrice: number): void {
    const symU = symbol.toUpperCase();
    if (Number.isFinite(markPrice)) this.lastMarkBySymbol.set(symU, markPrice);

    // Recompute unrealized PnL for *every* open position, using the latest mark we
    // have for each position's symbol. The mark just received is the freshest.
    let totalUnrealized = 0;
    for (const pos of this.positions.values()) {
      const refMark = pos.symbol === symU
        ? markPrice
        : (this.lastMarkBySymbol.get(pos.symbol) ?? pos.entryPrice);
      const sideMul = pos.side === 'LONG' ? 1 : -1;
      const unrealized = (refMark - pos.entryPrice) * pos.quantity * sideMul;
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

    void this.opts.redisState?.setMark(symU, markPrice);

    const now = Date.now();
    if (now - this.lastSnapshotTs >= this.opts.equitySnapshotMs) {
      this.lastSnapshotTs = now;
      this.snapshotCount += 1;
      const open: OpenSnapshot[] = Array.from(this.positions.values()).map((p) => {
        const refMark = p.symbol === symU
          ? markPrice
          : (this.lastMarkBySymbol.get(p.symbol) ?? p.entryPrice);
        return {
          orderId: p.orderId,
          side: p.side,
          entryPrice: p.entryPrice,
          quantity: p.quantity,
          unrealizedUsdt: ((refMark - p.entryPrice) * p.quantity) * (p.side === 'LONG' ? 1 : -1),
        };
      });

      const w = this.opts.wallet.state();

      // JSONL: write every Nth snapshot (1=legacy/every, 0=disable).
      const everyN = this.opts.equityJsonlEveryN ?? 1;
      if (everyN > 0 && this.snapshotCount % everyN === 0) {
        this.opts.ledger.snapshotEquity(w, open);
      }
      this.opts.wallet.flushToDisk();

      // Redis hot tail: always write — bounded by MAXLEN.
      void this.opts.redisState?.setWallet(w);
      void this.opts.redisState?.appendEquity({
        ts: now,
        equityUsdt: w.equityUsdt,
        balanceUsdt: w.balanceUsdt,
        unrealizedPnlUsdt: w.unrealizedPnlUsdt,
        realizedPnlUsdt: w.realizedPnlUsdt,
        usedMarginUsdt: w.usedMarginUsdt,
        inrPerUsdt: this.opts.fxRate?.getInrPerUsdt(),
      });
      void this.opts.redisState?.publishUpdate('wallet', { equityUsdt: w.equityUsdt });
    }
  }

  private snapshotPosition(p: OpenPaperPosition): object {
    return {
      orderId: p.orderId,
      pair: p.pair,
      symbol: p.symbol,
      side: p.side,
      entryPrice: p.entryPrice,
      quantity: p.quantity,
      leverage: p.leverage,
      marginUsdt: p.marginUsdt,
      liqPrice: p.liqPrice,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      openedAt: p.openedAt,
    };
  }

  async closePosition(orderId: string, reason: CloseReason, quantity?: number): Promise<ClosedPosition> {
    const pos = this.positions.get(orderId);
    if (!pos) throw new Error(`paper_close_unknown_order:${orderId}`);
    if (this.opts.latencyMs > 0) await sleep(this.opts.latencyMs);

    const qtyToClose = (quantity && quantity > 0 && quantity < pos.quantity) ? quantity : pos.quantity;
    const isPartial = qtyToClose < pos.quantity;

    const tick = this.opts.book.latest(pos.symbol);
    const lastTrade = this.opts.book.lastTrade(pos.symbol);
    const refMid = tick ? (tick.bestAsk + tick.bestBid) / 2 : lastTrade ?? pos.entryPrice;
    const spread = tick ? tick.spread : Math.max(refMid * 0.0001, 0);
    const topBookQty = (this.opts.partialFills && tick)
      ? (pos.side === 'LONG' ? tick.bestBidQty : tick.bestAskQty)
      : undefined;

    const slip = SlippageEngine.priceImpactUsdt({
      side: pos.side,
      quantity: qtyToClose,
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
    const gross = (exitPrice - pos.entryPrice) * qtyToClose * sideMul;
    const exitNotional = exitPrice * qtyToClose;
    const exitFee = computeFee(exitNotional, true, this.opts.takerFee, this.opts.makerFee);

    // For partials, we only attribute a fraction of the entry fee.
    const entryFeeAttributed = isPartial ? (pos.entryFeeUsdt * (qtyToClose / pos.quantity)) : pos.entryFeeUsdt;
    const totalFees = entryFeeAttributed + exitFee;

    // Funding is tracked per orderId; for partials we accrue everything so far
    // and potentially keep tracking the remainder.
    const funding = this.opts.funding.accruedFor(orderId);
    const net = gross - totalFees - funding;

    const marginReleased = isPartial ? (pos.marginUsdt * (qtyToClose / pos.quantity)) : pos.marginUsdt;

    this.opts.wallet.releaseMargin(marginReleased + entryFeeAttributed);
    this.opts.wallet.applyRealized(net);
    this.opts.wallet.setUnrealized(0);

    if (isPartial) {
      pos.quantity -= qtyToClose;
      pos.marginUsdt -= marginReleased;
      pos.entryFeeUsdt -= entryFeeAttributed;
      void this.opts.redisState?.upsertPosition(orderId, this.snapshotPosition(pos));
    } else {
      this.opts.liquidation.untrack(orderId);
      this.opts.funding.untrackPosition(orderId);
      this.positions.delete(orderId);
      this.unrealizedByOrder.delete(orderId);
      void this.opts.redisState?.removePosition(orderId);
    }
    this.flushPositionsToDisk();

    void this.opts.redisState?.setWallet(this.opts.wallet.state());
    void this.opts.redisState?.publishUpdate('position', {
      event: isPartial ? 'partial_close' : 'close',
      orderId,
      symbol: pos.symbol
    });

    const closed: ClosedPosition = {
      orderId,
      symbol: pos.symbol,
      side: pos.side,
      leverage: pos.leverage,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: qtyToClose,
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
    stopLoss?: number;
    takeProfit?: number;
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
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
    }));
  }

  getWalletState() {
    return this.opts.wallet.state();
  }

  setOnTradeClose(cb: (trade: ClosedPosition) => void): void {
    this.opts.onTradeClose = cb;
  }

  setFxRate(fx: { getInrPerUsdt(): number }): void {
    this.opts.fxRate = fx;
  }

  async setLeverage(_pair: string, _lev: number): Promise<void> {
    return;
  }
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => setTimeout(r, ms));
}
