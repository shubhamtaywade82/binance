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
  fundingUsdt: number;
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

  /**
   * Size a position.
   *
   * Backwards compatible: `sizePosition(price)` / `sizePosition(price, step)` /
   * `sizePosition(price, step, realizedVol)` keep their original meaning.
   *
   * Per-tier overrides:
   *   - `opts.marginUsdt`: replaces `CAPITAL_PER_TRADE_USDT` for this call.
   *   - `opts.leverage`:   replaces `cfg.LEVERAGE` for this call.
   *   - `opts.realizedVol`: identical to the legacy 3rd-positional arg.
   */
  sizePosition(
    entryPrice: number,
    stepSize = 0.001,
    optsOrVol?: number | { leverage?: number; marginUsdt?: number; realizedVol?: number },
  ): SizeResult {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return { quantity: 0, notionalUsdt: 0, marginInr: 0, marginUsdt: 0 };
    }
    const opts = typeof optsOrVol === 'number' ? { realizedVol: optsOrVol } : (optsOrVol ?? {});
    const fx = this.inrPerUsdt();

    const usdtCap = this.cfg.CAPITAL_PER_TRADE_USDT;
    const baseMargin = typeof opts.marginUsdt === 'number' && opts.marginUsdt > 0
      ? opts.marginUsdt
      : (usdtCap > 0 ? usdtCap : this.cfg.CAPITAL_PER_TRADE_INR / fx);
    let marginUsdt = baseMargin;

    if (this.cfg.VOL_ADJUSTED_SIZING && opts.realizedVol !== undefined && this.cfg.VOL_BASELINE > 0) {
      const ratio = Math.min(Math.max(this.cfg.VOL_BASELINE / opts.realizedVol, 0.5), 1.0);
      marginUsdt *= ratio;
    }

    const leverage = typeof opts.leverage === 'number' && opts.leverage > 0 ? opts.leverage : this.cfg.LEVERAGE;

    let notionalUsdt = marginUsdt * leverage;
    const maxNotional = this.cfg.MAX_NOTIONAL_USDT;
    if (maxNotional > 0 && notionalUsdt > maxNotional) {
      notionalUsdt = maxNotional;
      marginUsdt = leverage > 0 ? notionalUsdt / leverage : 0;
    }
    const marginInr = marginUsdt * fx;
    const rawQty = notionalUsdt / entryPrice;
    const quantity = floorToStep(rawQty, stepSize);
    return { quantity, notionalUsdt, marginInr, marginUsdt };
  }

  /**
   * Compute TP/SL prices for a side.
   *
   * Per-tier overrides:
   *   - `opts.tpPct`: replaces `TP_PRICE_PCT`.
   *   - `opts.slPct`: replaces `SL_PRICE_PCT`.
   */
  targets(entryPrice: number, side: Side, opts?: { tpPct?: number; slPct?: number }): TargetResult {
    const tpMove = typeof opts?.tpPct === 'number' && opts.tpPct > 0 ? opts.tpPct : this.cfg.TP_PRICE_PCT;
    const slMove = typeof opts?.slPct === 'number' && opts.slPct > 0 ? opts.slPct : this.cfg.SL_PRICE_PCT;
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
    const fundingUsdt = entryNotional * this.cfg.FUNDING_FEE_EST;
    const feesUsdt = entryNotional * taker + exitNotional * taker;
    const netUsdt = grossUsdt - feesUsdt - fundingUsdt;
    const fx = this.inrPerUsdt();
    const netInr = netUsdt * fx;
    const marginUsdt = this.cfg.CAPITAL_PER_TRADE_INR / fx;
    const pctOnMargin = marginUsdt > 0 ? netUsdt / marginUsdt : 0;
    return { grossUsdt, feesUsdt, fundingUsdt, netUsdt, netInr, pctOnMargin };
  }
}
