import { StrategyModule, StrategyContext } from '../core/strategy/strategy-module';
import { Candle } from '../types';
import { OrderRequestedPayload } from '@coindcx/contracts';
import { ema, atr, adx } from './indicators';

export interface SeykotaConfig {
  /** Higher timeframe used for trend bias (e.g. '1h', '4h'). */
  htf: string;
  /** Periods for EMAs (LTF + HTF share the same lengths). */
  fastEma: number;
  slowEma: number;
  /** ADX length + threshold. ADX < threshold = chop → no trade. */
  adxPeriod: number;
  adxThreshold: number;
  /** ATR length + stop multiplier. Stop = entry ± atrMult × atr. */
  atrPeriod: number;
  atrMult: number;
  /**
   * Min ATR as fraction of price. Filters dead markets where
   * even an ATR-stop would be sub-tick. e.g. 0.003 = 0.3%.
   */
  minAtrPct: number;
  /**
   * Risk per trade as fraction of equity (e.g. 0.005 = 0.5%).
   * qty = (equity * riskPct) / stopDistance, then notional check.
   */
  riskPct: number;
  /** Account equity assumption (USDT). Sized from this. */
  equityUsdt: number;
  /** Min bars of history before strategy can emit. */
  minBars: number;
}

export const DEFAULT_SEYKOTA: SeykotaConfig = {
  htf: '1h',
  fastEma: 20,
  slowEma: 50,
  adxPeriod: 14,
  adxThreshold: 20,
  atrPeriod: 14,
  atrMult: 3,
  minAtrPct: 0.003,
  riskPct: 0.005,
  equityUsdt: 10_000,
  minBars: 80,
};

/**
 * SeykotaTrendModule — modern Ed Seykota-style trend follower.
 *
 *   1. HTF bias: fast EMA > slow EMA on `htf` candles (and rising)
 *   2. LTF trigger: same EMA stack on execution TF + close above fastEma
 *   3. Regime filter: ADX >= adxThreshold AND ATR/price >= minAtrPct (chop kill)
 *   4. Sizing: position size = (equity * riskPct) / (atrMult * atr)
 *   5. Initial stop emitted on the order; trailing stop handled externally
 *      by TrailingStopManager (subscribes execution.order.filled).
 *   6. Pyramiding intentionally NOT implemented — RiskEngine's opposite-side
 *      guard also blocks adds in same direction by current design.
 *      (Pyramiding will land in Phase 2 with a position-add event type.)
 *
 * Returns OrderRequestedPayload directly so SignalToOrderBridge sizing is
 * bypassed — Seykota owns its own volatility sizing.
 */
export class SeykotaTrendModule extends StrategyModule {
  constructor(ctx: StrategyContext, private readonly cfg: SeykotaConfig = DEFAULT_SEYKOTA) {
    super(ctx);
  }

  public getName(): string {
    return `Seykota(${this.cfg.fastEma}/${this.cfg.slowEma},adx${this.cfg.adxThreshold},atr×${this.cfg.atrMult})`;
  }

  public onKline(candle: Candle): OrderRequestedPayload | null {
    const ltf = this.ctx.getHistory();
    if (ltf.length < this.cfg.minBars) return null;
    const htf = this.ctx.getHistory(this.cfg.htf);
    if (htf.length < this.cfg.minBars) return null;

    const htfBias = this.trendBias(htf);
    if (htfBias === 'FLAT') return null;

    const ltfBias = this.trendBias(ltf);
    if (ltfBias !== htfBias) return null;

    const closes = ltf.map((c) => c.close);
    const fast = ema(closes, this.cfg.fastEma);
    const last = fast[fast.length - 1];
    if (!Number.isFinite(last)) return null;
    if (htfBias === 'LONG' && candle.close < last) return null;
    if (htfBias === 'SHORT' && candle.close > last) return null;

    const adxSeries = adx(ltf, this.cfg.adxPeriod);
    const adxLast = adxSeries.adx[adxSeries.adx.length - 1];
    const plusDi = adxSeries.plusDi[adxSeries.plusDi.length - 1];
    const minusDi = adxSeries.minusDi[adxSeries.minusDi.length - 1];
    if (!Number.isFinite(adxLast) || adxLast < this.cfg.adxThreshold) return null;
    if (htfBias === 'LONG' && plusDi <= minusDi) return null;
    if (htfBias === 'SHORT' && minusDi <= plusDi) return null;

    const atrSeries = atr(ltf, this.cfg.atrPeriod);
    const atrLast = atrSeries[atrSeries.length - 1];
    if (!Number.isFinite(atrLast) || atrLast <= 0) return null;
    if (atrLast / candle.close < this.cfg.minAtrPct) return null;

    const stopDistance = this.cfg.atrMult * atrLast;
    if (stopDistance <= 0) return null;

    const riskUsdt = this.cfg.equityUsdt * this.cfg.riskPct;
    const quantity = riskUsdt / stopDistance;
    if (quantity <= 0) return null;

    const stopLoss = htfBias === 'LONG'
      ? candle.close - stopDistance
      : candle.close + stopDistance;

    return {
      symbol: this.ctx.symbol,
      side: htfBias,
      quantity,
      type: 'MARKET',
      price: candle.close,
      stopLoss,
      strategyId: this.getName(),
      score: {
        adx: adxLast,
        atrPct: atrLast / candle.close,
        closeTime: candle.closeTime ?? candle.openTime,
      },
    };
  }

  /** Fast EMA > slow EMA + fast EMA slope agrees → trend; else FLAT. */
  private trendBias(candles: Candle[]): 'LONG' | 'SHORT' | 'FLAT' {
    const closes = candles.map((c) => c.close);
    const fast = ema(closes, this.cfg.fastEma);
    const slow = ema(closes, this.cfg.slowEma);
    const i = fast.length - 1;
    const j = Math.max(0, i - 3);
    if (!Number.isFinite(fast[i]) || !Number.isFinite(slow[i])) return 'FLAT';
    if (!Number.isFinite(fast[j])) return 'FLAT';
    const slopeUp = fast[i] > fast[j];
    const slopeDown = fast[i] < fast[j];
    if (fast[i] > slow[i] && slopeUp) return 'LONG';
    if (fast[i] < slow[i] && slopeDown) return 'SHORT';
    return 'FLAT';
  }
}
