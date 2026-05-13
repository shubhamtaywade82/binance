import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../config';
import type { InstrumentPrecision } from '../mapping/precision';
import type { CloseReason, Position, Side, TrendBias } from '../types';
import type { RiskManager } from './risk';
import type { ExecutionAdapter, TradeAttribution } from '../execution/types';

export interface PositionLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface CloseEvent {
  position: Position;
  exitPrice: number;
  reason: CloseReason;
  pnl: ReturnType<RiskManager['netPnl']>;
}

export class PositionManager {
  private current: (Position & { orderId: string }) | null = null;
  private currentAttribution: TradeAttribution | undefined;
  /** Prevents concurrent close attempts for the same position. */
  private closingInProgress = false;
  private placeOrderDisabledLogged = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly adapter: ExecutionAdapter,
    private readonly risk: RiskManager,
    private readonly log: PositionLogger,
  ) {}

  get position(): Position | null {
    return this.current;
  }

  hasPosition(): boolean {
    return this.current !== null;
  }

  openCount(): number {
    return this.current !== null ? 1 : 0;
  }

  async open(side: Side, price: number, precision: InstrumentPrecision, pair: string, attribution?: TradeAttribution): Promise<Position | null> {
    if (!this.cfg.PLACE_ORDER) {
      if (!this.placeOrderDisabledLogged) {
        this.placeOrderDisabledLogged = true;
        this.log.warn('place_order_disabled', {
          hint:
            'Set PLACE_ORDER=true for simulated (paper) or live adapter fills. Exchange REST orders only when EXECUTION_MODE=live, READ_ONLY=false, and API keys are set.',
        });
      }
      return null;
    }
    if (this.current) return this.current;
    const sized = this.risk.sizePosition(price, precision.stepSize);
    if (sized.quantity <= 0) {
      this.log.warn('open_skipped_zero_qty', { price, precision });
      return null;
    }
    const { takeProfit, stopLoss } = this.risk.targets(price, side);

    const result = await this.adapter.placeOrder({
      pair,
      side,
      quantity: sized.quantity,
      leverage: this.cfg.LEVERAGE,
      marginCurrency: this.cfg.MARGIN_CURRENCY,
      referencePrice: price,
      takeProfit,
      stopLoss,
    });

    if (!result.ok) {
      this.log.warn('open_order_failed', { mode: this.adapter.name, error: result.error });
      return null;
    }

    const pos: Position & { orderId: string } = {
      side,
      entryPrice: result.fill.price,
      quantity: sized.quantity,
      takeProfit,
      stopLoss,
      openedAt: result.fill.timestamp,
      pair,
      notionalUsdt: sized.notionalUsdt,
      marginInr: sized.marginInr,
      orderId: result.orderId,
    };
    this.current = pos;
    this.currentAttribution = attribution;
    this.log.info(this.adapter.name === 'live' ? 'live_open' : 'paper_open', {
      side, price: pos.entryPrice, qty: pos.quantity, tp: takeProfit, sl: stopLoss, pair,
      orderId: result.orderId,
      ...(attribution ?? {}),
    });
    return pos;
  }

  async onMark(price: number, htfTrend: TrendBias): Promise<CloseEvent | null> {
    const pos = this.current;
    if (!pos || !Number.isFinite(price)) return null;

    if (pos.side === 'LONG') {
      if (price >= pos.takeProfit) return this.close(price, 'TP');
      if (price <= pos.stopLoss) return this.close(price, 'SL');
    } else {
      if (price <= pos.takeProfit) return this.close(price, 'TP');
      if (price >= pos.stopLoss) return this.close(price, 'SL');
    }

    if (htfTrend !== 'NONE' && htfTrend !== pos.side) {
      return this.close(price, 'REVERSAL');
    }
    return null;
  }

  async close(exitPrice: number, reason: CloseReason): Promise<CloseEvent | null> {
    // Guard: if already closing (concurrent onMark ticks), skip.
    if (this.closingInProgress) return null;
    const pos = this.current;
    if (!pos) return null;

    this.closingInProgress = true;
    // Nullify BEFORE the async adapter call so concurrent onMark ticks see no position.
    this.current = null;

    try {
      await this.adapter.closePosition(pos.orderId, reason);
    } catch (e) {
      this.log.warn('exit_order_failed', { err: (e as Error).message });
    } finally {
      this.closingInProgress = false;
    }

    const pnl = this.risk.netPnl(pos.entryPrice, exitPrice, pos.side, pos.quantity);
    const event: CloseEvent = { position: pos, exitPrice, reason, pnl };
    this.appendCsv(event);
    this.log.info('position_closed', {
      side: pos.side,
      entry: pos.entryPrice,
      exit: exitPrice,
      reason,
      netUsdt: pnl.netUsdt,
      netInr: pnl.netInr,
    });
    return event;
  }

  /**
   * Called by the orchestrator when exchange algo TP/SL fills (ORDER_TRADE_UPDATE FILLED).
   * Skips the adapter call — the exchange already closed the position on its side.
   */
  async notifyExchangeClose(exitPrice: number, reason: CloseReason): Promise<CloseEvent | null> {
    const pos = this.current;
    if (!pos) return null;
    // Clear state without calling adapter (exchange already did the close).
    this.current = null;
    this.closingInProgress = false;
    const pnl = this.risk.netPnl(pos.entryPrice, exitPrice, pos.side, pos.quantity);
    const event: CloseEvent = { position: pos, exitPrice, reason, pnl };
    this.appendCsv(event);
    this.log.info('position_closed', {
      side: pos.side,
      entry: pos.entryPrice,
      exit: exitPrice,
      reason,
      netUsdt: pnl.netUsdt,
      netInr: pnl.netInr,
      source: 'exchange',
    });
    return event;
  }

  /**
   * Restore position state after bot restart (startup reconciliation).
   * Called after binance-adapter.restoreFromExchange() returns the internalId.
   */
  restoreFromExchange(params: {
    side: Side;
    entryPrice: number;
    quantity: number;
    pair: string;
    orderId: string;
    takeProfit: number;
    stopLoss: number;
    openedAt: number;
    notionalUsdt: number;
  }): void {
    if (this.current) return;
    this.current = {
      side: params.side,
      entryPrice: params.entryPrice,
      quantity: params.quantity,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
      openedAt: params.openedAt,
      pair: params.pair,
      notionalUsdt: params.notionalUsdt,
      marginInr: 0,
      orderId: params.orderId,
    };
    this.log.info('position_restored', {
      side: params.side,
      entry: params.entryPrice,
      qty: params.quantity,
      orderId: params.orderId,
    });
  }

  private appendCsv(event: CloseEvent): void {
    const csvPath = this.cfg.TRADE_LOG_PATH || this.cfg.TRADES_CSV_PATH;
    try {
      const dir = path.dirname(csvPath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const headers =
        'time,side,entry,exit,qty,reason,grossUsdt,netUsdt,netInr,pctOnMargin,entrySignal,smcZone,htfBias,confidence\n';
      if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, headers);
      const { position: p, exitPrice, reason, pnl } = event;
      const a = this.currentAttribution;
      const row = [
        new Date().toISOString(),
        p.side,
        p.entryPrice,
        exitPrice,
        p.quantity,
        reason,
        pnl.grossUsdt.toFixed(6),
        pnl.netUsdt.toFixed(6),
        pnl.netInr.toFixed(2),
        pnl.pctOnMargin.toFixed(6),
        a?.entrySignal ?? '',
        a?.smcZone ?? '',
        a?.htfBias ?? '',
        a?.confidence?.toFixed(2) ?? '',
      ].join(',') + '\n';
      fs.appendFileSync(csvPath, row);
      this.currentAttribution = undefined;
    } catch (e) {
      this.log.warn('csv_write_failed', { err: (e as Error).message });
    }
  }
}
