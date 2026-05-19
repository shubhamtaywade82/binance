import { StrategyModule, StrategyContext } from '../core/strategy/strategy-module';
import type { Candle } from '../types';
import type { OrderRequestedPayload } from '@coindcx/contracts';
import type { DomainEvent } from '@coindcx/contracts';
import { atr } from './indicators';
import { RegimeDetector, type Regime, type RegimeSignal } from './regime-detector';
import { DEFAULT_MODES, type TpRung, type TradeModeProfile } from './trade-mode';

export interface AdaptiveStrategyConfig {
  htf: string;
  equityUsdt: number;
  /** Override default mode catalog. JSON-parsed in index.ts then passed here. */
  modeOverrides?: Partial<Record<Regime, TradeModeProfile | null>>;
  atrPeriod: number;
  minBars: number;
  /** Cooldown between consecutive entries per actor (ms). */
  cooldownMs: number;
  /**
   * Hard per-order notional cap (USDT). When risk-based sizing
   * (`riskPct × equity / (atrMult × ATR)`) produces a quantity whose
   * notional exceeds this, quantity is shrunk to fit. Without this,
   * tight-ATR regimes on high-priced assets blow past the RiskEngine cap
   * and every order rejects as MAX_PER_ORDER_NOTIONAL_EXCEEDED.
   */
  maxNotionalUsdt?: number;
}

export const DEFAULT_ADAPTIVE_CFG: AdaptiveStrategyConfig = {
  htf: '1h',
  equityUsdt: 10_000,
  atrPeriod: 14,
  minBars: 80,
  cooldownMs: 5 * 60_000,
};

/**
 * AdaptiveStrategy — multi-regime, mode-driven entries.
 *
 * On every kline.closed:
 *   1. RegimeDetector classifies the symbol's state on LTF + HTF.
 *   2. pickMode(regime) → TradeModeProfile (or null = skip).
 *   3. Apply mode-specific direction check vs HTF alignment.
 *   4. Size via mode.riskPct × equity / (atrStopMult × ATR), respect leverage.
 *   5. Emit OrderRequestedPayload with tpLadder + mode metadata. The
 *      TpLadderManager consumes tpLadder on fill to schedule partial exits.
 *
 * State: tracks inPosition (binary) so it doesn't spam pyramids in this
 * version. Pyramiding lives in SeykotaTrendModule; here we focus on regime
 * accuracy + TP ladder execution. Re-entries allowed after position closes
 * + cooldown elapses.
 */
export class AdaptiveStrategy extends StrategyModule {
  private inPosition = false;
  private lastEmitTs = 0;
  private readonly detector: RegimeDetector;

  constructor(ctx: StrategyContext, private readonly cfg: AdaptiveStrategyConfig = DEFAULT_ADAPTIVE_CFG) {
    super(ctx);
    this.detector = new RegimeDetector();
    this.ctx.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => {
      if ((e.symbol || e.payload?.symbol) !== this.ctx.symbol) return;
      this.inPosition = true;
    });
    this.ctx.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
      if ((e.symbol || e.payload?.symbol) !== this.ctx.symbol) return;
      if (e.payload?.reason === 'PARTIAL_TP') return;
      this.inPosition = false;
    });
  }

  public getName(): string { return 'Adaptive(regime-aware)'; }

  public onKline(candle: Candle): OrderRequestedPayload | null {
    if (this.inPosition) return null; // ladder + trail handle the rest
    const now = candle.closeTime ?? candle.openTime ?? Date.now();
    if (now - this.lastEmitTs < this.cfg.cooldownMs) return null;

    const ltf = this.ctx.getHistory();
    if (ltf.length < this.cfg.minBars) return null;
    const htf = this.ctx.getHistory(this.cfg.htf);

    const ltfSig = this.detector.classify(ltf);
    if (ltfSig.regime === 'CHOP' || ltfSig.direction === 'FLAT') return null;

    const mode = (this.cfg.modeOverrides?.[ltfSig.regime]) ?? DEFAULT_MODES[ltfSig.regime];
    if (!mode) return null;
    if (ltfSig.confidence < mode.minRegimeConfidence) return null;

    // HTF alignment: if HTF available and disagrees with LTF direction → skip
    // (unless mode is MEAN_REVERT / RANGE, which fade against HTF intentionally).
    if (htf.length >= this.cfg.minBars && (mode.id === 'SWING' || mode.id === 'BREAKOUT_SCALP')) {
      const htfSig = this.detector.classify(htf);
      if (htfSig.direction !== 'FLAT' && htfSig.direction !== ltfSig.direction) return null;
    }

    const atrSeries = atr(ltf, this.cfg.atrPeriod);
    const atrLast = atrSeries[atrSeries.length - 1];
    if (!Number.isFinite(atrLast) || atrLast <= 0) return null;

    const stopDistance = mode.atrStopMult * atrLast;
    if (stopDistance <= 0) return null;
    const riskUsdt = this.cfg.equityUsdt * mode.riskPct;
    let quantity = riskUsdt / stopDistance;
    if (quantity <= 0) return null;

    // Cap qty to honour the RiskEngine MAX_PER_ORDER notional. Tight ATR on a
    // high-priced asset (BTC, ETH) otherwise produces ~$20–30k notional from a
    // $50–100 risk budget and every order rejects with
    // MAX_PER_ORDER_NOTIONAL_EXCEEDED.
    const maxNot = this.cfg.maxNotionalUsdt;
    if (Number.isFinite(maxNot) && (maxNot as number) > 0 && candle.close > 0) {
      const qtyCap = (maxNot as number) / candle.close;
      if (quantity > qtyCap) quantity = qtyCap;
    }

    const side = ltfSig.direction;
    const dirMul = side === 'LONG' ? 1 : -1;
    const stopLoss = candle.close - dirMul * stopDistance;

    // Build tpLadder absolute prices so downstream manager doesn't need entry context.
    const tpLadder = mode.tpLadder.map((r: TpRung) => ({
      price: candle.close * (1 + dirMul * r.pricePct / 100),
      fraction: r.fraction,
      pricePct: r.pricePct,
    }));

    this.lastEmitTs = now;

    return {
      symbol: this.ctx.symbol,
      side,
      quantity,
      type: 'MARKET',
      price: candle.close,
      stopLoss,
      strategyId: `${this.getName()}/${mode.id}`,
      score: {
        adx: ltfSig.metrics.adx,
        atrPct: ltfSig.metrics.atrPct,
        closeTime: candle.closeTime ?? candle.openTime ?? Date.now(),
      },
      // Custom fields read by TpLadderManager (RiskEngine ignores extras).
      ...({
        tpLadder,
        regime: ltfSig.regime,
        modeId: mode.id,
        leverageHint: mode.leverage,
        trailAfterLadder: mode.trailAfterLadder,
        maxHoldBars: mode.maxHoldBars,
        regimeConfidence: ltfSig.confidence,
      } as any),
    } as OrderRequestedPayload;
  }

  public classifyForDebug(candles: Candle[]): RegimeSignal {
    return this.detector.classify(candles);
  }
}
