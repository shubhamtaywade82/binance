import type { AppConfig } from '../config';
import { floorToStep } from '../mapping/precision';
import type { Side } from '../types';

export interface InrUsdtFxRate {
  getInrPerUsdt(): number;
}

export interface SizeResult {
  quantity: number;
  notionalUsdt: number;
  marginInr: number;
  marginUsdt: number;
}

export interface TargetResult {
  takeProfit: number;
  stopLoss: number;
}

export interface PnlResult {
  grossUsdt: number;
  feesUsdt: number;
  netUsdt: number;
  netInr: number;
  pctOnMargin: number;
}

export class RiskManager {
  constructor(private readonly cfg: AppConfig, private readonly fx?: InrUsdtFxRate) {}

  private inrPerUsdt(): number {
    const live = this.fx?.getInrPerUsdt();
    return live && Number.isFinite(live) && live > 0 ? live : this.cfg.INR_PER_USDT;
  }

  sizePosition(entryPrice: number, stepSize = 0.001, realizedVol?: number): SizeResult {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return { quantity: 0, notionalUsdt: 0, marginInr: 0, marginUsdt: 0 };
    }
    const fx = this.inrPerUsdt();
    const usdtCap = this.cfg.CAPITAL_PER_TRADE_USDT;
    let marginUsdt = usdtCap > 0 ? usdtCap : this.cfg.CAPITAL_PER_TRADE_INR / fx;

    if (this.cfg.VOL_ADJUSTED_SIZING && realizedVol !== undefined && this.cfg.VOL_BASELINE > 0) {
      const ratio = Math.min(Math.max(this.cfg.VOL_BASELINE / realizedVol, 0.5), 1.0);
      marginUsdt *= ratio;
    }

    let notionalUsdt = marginUsdt * this.cfg.LEVERAGE;
    const maxNotional = this.cfg.MAX_NOTIONAL_USDT;
    if (maxNotional > 0 && notionalUsdt > maxNotional) {
      notionalUsdt = maxNotional;
      marginUsdt = this.cfg.LEVERAGE > 0 ? notionalUsdt / this.cfg.LEVERAGE : 0;
    }
    const marginInr = marginUsdt * fx;
    const rawQty = notionalUsdt / entryPrice;
    const quantity = floorToStep(rawQty, stepSize);
    return { quantity, notionalUsdt, marginInr, marginUsdt };
  }

  targets(entryPrice: number, side: Side): TargetResult {
    const tpMove = this.cfg.TP_PRICE_PCT;
    const slMove = this.cfg.SL_PRICE_PCT;
    if (side === 'LONG') {
      return {
        takeProfit: entryPrice * (1 + tpMove),
        stopLoss: entryPrice * (1 - slMove),
      };
    }
    return {
      takeProfit: entryPrice * (1 - tpMove),
      stopLoss: entryPrice * (1 + slMove),
    };
  }

  netPnl(entryPrice: number, exitPrice: number, side: Side, qty: number): PnlResult {
    const direction = side === 'LONG' ? 1 : -1;
    const grossUsdt = (exitPrice - entryPrice) * qty * direction;
    const entryNotional = entryPrice * qty;
    const exitNotional = exitPrice * qty;
    const taker = this.cfg.TAKER_FEE;
    const funding = this.cfg.FUNDING_FEE_EST;
    const feesUsdt = entryNotional * taker + exitNotional * taker + entryNotional * funding;
    const netUsdt = grossUsdt - feesUsdt;
    const fx = this.inrPerUsdt();
    const netInr = netUsdt * fx;
    const marginUsdt = this.cfg.CAPITAL_PER_TRADE_INR / fx;
    const pctOnMargin = marginUsdt > 0 ? netUsdt / marginUsdt : 0;
    return { grossUsdt, feesUsdt, netUsdt, netInr, pctOnMargin };
  }
}
