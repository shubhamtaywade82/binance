import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../config';
import type { CoinDcxFuturesClient } from '../coindcx/futures-client';
import type { InstrumentPrecision } from '../mapping/precision';
import type { CloseReason, Position, Side, TrendBias } from '../types';
import type { RiskManager } from './risk';

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
  private current: Position | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly cdcx: CoinDcxFuturesClient,
    private readonly risk: RiskManager,
    private readonly log: PositionLogger,
  ) {}

  get position(): Position | null {
    return this.current;
  }

  hasPosition(): boolean {
    return this.current !== null;
  }

  private canExecute(): boolean {
    return (
      this.cfg.EXECUTION_ENABLED &&
      !this.cfg.READ_ONLY &&
      Boolean(this.cfg.COINDCX_API_KEY.trim()) &&
      Boolean(this.cfg.COINDCX_API_SECRET.trim())
    );
  }

  async open(side: Side, price: number, precision: InstrumentPrecision, pair: string): Promise<Position | null> {
    if (this.current) return this.current;
    const sized = this.risk.sizePosition(price, precision.stepSize);
    if (sized.quantity <= 0) {
      this.log.warn('open_skipped_zero_qty', { price, precision });
      return null;
    }
    const { takeProfit, stopLoss } = this.risk.targets(price, side);
    const pos: Position = {
      side,
      entryPrice: price,
      quantity: sized.quantity,
      takeProfit,
      stopLoss,
      openedAt: Date.now(),
      pair,
      notionalUsdt: sized.notionalUsdt,
      marginInr: sized.marginInr,
    };

    if (!this.canExecute()) {
      this.current = pos;
      this.log.info('paper_open', {
        side, price, qty: pos.quantity, tp: takeProfit, sl: stopLoss, pair,
      });
      return pos;
    }

    try {
      await this.cdcx.updatePositionLeverage({ pair, leverage: this.cfg.LEVERAGE });
    } catch (e) {
      this.log.warn('leverage_update_failed', { err: (e as Error).message });
    }

    try {
      await this.cdcx.createFuturesOrder({
        pair,
        side: side === 'LONG' ? 'buy' : 'sell',
        order_type: 'market',
        price: null,
        stop_price: null,
        total_quantity: pos.quantity,
        notification: 'no_notification',
        margin_currency_short_name: this.cfg.MARGIN_CURRENCY,
      });
    } catch (e) {
      this.log.warn('open_order_failed', { err: (e as Error).message });
      return null;
    }

    try {
      await this.cdcx.createFuturesTpSlOrders({
        pair,
        side: side === 'LONG' ? 'sell' : 'buy',
        total_quantity: pos.quantity,
        take_profit_price: takeProfit,
        stop_loss_price: stopLoss,
        margin_currency_short_name: this.cfg.MARGIN_CURRENCY,
      });
    } catch (e) {
      this.log.warn('tpsl_failed', { err: (e as Error).message });
    }

    this.current = pos;
    this.log.info('live_open', {
      side, price, qty: pos.quantity, tp: takeProfit, sl: stopLoss, pair,
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
    const pos = this.current;
    if (!pos) return null;

    if (this.canExecute()) {
      try {
        await this.cdcx.exitFuturesPosition({ pair: pos.pair, quantity: pos.quantity });
      } catch (e) {
        this.log.warn('exit_order_failed', { err: (e as Error).message });
      }
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
    this.current = null;
    return event;
  }

  private appendCsv(event: CloseEvent): void {
    const csvPath = this.cfg.TRADE_LOG_PATH || this.cfg.TRADES_CSV_PATH;
    try {
      const dir = path.dirname(csvPath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const headers =
        'time,side,entry,exit,qty,reason,grossUsdt,netUsdt,netInr,pctOnMargin\n';
      if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, headers);
      const { position: p, exitPrice, reason, pnl } = event;
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
      ].join(',') + '\n';
      fs.appendFileSync(csvPath, row);
    } catch (e) {
      this.log.warn('csv_write_failed', { err: (e as Error).message });
    }
  }
}
