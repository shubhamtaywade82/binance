import { StrategyModule, StrategyContext } from '../core/strategy/strategy-module';
import { Candle } from '../types';
import { OrderRequestedPayload, DomainEvent } from '@coindcx/contracts';
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
  /** Max pyramiding additions. 0 to disable. */
  pyramidMaxAdds?: number;
  /** Distance in R-multiples to add a pyramid position. */
  pyramidRDistance?: number;
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
  pyramidMaxAdds: 0,
  pyramidRDistance: 1.0,
};

/**
 * SeykotaTrendModule — modern Ed Seykota-style trend follower.
 *
 *   1. HTF bias: fast EMA > slow EMA on `htf` candles (and rising)
 *   2. LTF trigger: same EMA stack on execution TF + close above fastEma
 *   3. Regime filter: ADX >= adxThreshold AND ATR/price >= minAtrPct (chop kill)
 *   4. Sizing: position size = (equity * riskPct) / (atrMult * atr)
 *   5. Initial stop emitted on the order; trailing stop handled externally
 *      by TrailingStopManager.
 *   6. Pyramiding: if enabled, emits additional buy/sell signals when the trade 
 *      moves in favor by pyramidRDistance * ATR from the last fill.
 */
export class SeykotaTrendModule extends StrategyModule {
  private lastEntryPrice = 0;
  private pyramidCount = 0;
  private inPosition = false;

  constructor(ctx: StrategyContext, private readonly cfg: SeykotaConfig = DEFAULT_SEYKOTA) {
    super(ctx);
    // Subscribe to position events to track local state for pyramiding
    this.ctx.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => {
      const sym = e.symbol || (e.payload as any)?.symbol;
      if (sym === this.ctx.symbol) {
        this.inPosition = true;
        this.lastEntryPrice = Number((e.payload as any).price);
        if ((e.payload as any).reason === 'PYRAMID') {
          this.pyramidCount++;
        } else {
          this.pyramidCount = 0;
        }
      }
    });
    this.ctx.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
      const sym = e.symbol || (e.payload as any)?.symbol;
      if (sym === this.ctx.symbol && (e.payload as any).reason !== 'PARTIAL_TP') {
        this.inPosition = false;
        this.pyramidCount = 0;
      }
    });
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
    const lastFast = fast[fast.length - 1];
    if (!Number.isFinite(lastFast)) return null;
    if (htfBias === 'LONG' && candle.close < lastFast) return null;
    if (htfBias === 'SHORT' && candle.close > lastFast) return null;

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

    // Pyramiding Check
    if (this.inPosition) {
      if (!this.cfg.pyramidMaxAdds || this.pyramidCount >= this.cfg.pyramidMaxAdds) return null;
      
      const rDist = (this.cfg.pyramidRDistance ?? 1.0) * atrLast;
      const isProfitableEnough = htfBias === 'LONG' 
        ? candle.close >= this.lastEntryPrice + rDist
        : candle.close <= this.lastEntryPrice - rDist;
      
      if (!isProfitableEnough) return null;
    }

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
      reason: this.inPosition ? 'PYRAMID' : 'ENTRY',
      score: {
        adx: adxLast,
        atrPct: atrLast / candle.close,
        closeTime: candle.closeTime ?? candle.openTime,
      },
    } as any;
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
