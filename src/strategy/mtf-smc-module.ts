import { StrategyModule, StrategyContext } from '../core/strategy/strategy-module';
import type { Candle } from '../types';
import { evaluateMtfSmcStrategy, type MtfSmcTf } from './mtf-smc-strategy';
import { evaluateSmcConfluence } from './smc-confluence';
import { atr as computeAtr, supertrend } from './indicators';
import type { SignalPayload, OrderRequestedPayload } from '@coindcx/contracts';

/**
 * Unified multi-timeframe SMC strategy module for all watchlist futures.
 *
 * Replaces the symbol-gated SolMtfStrategyModule + SmcStrategyModule pair.
 * Runs the full 5-TF cascade (1d → 4h → 1h → 15m → 5m), applies the
 * Adaptive Supertrend (ADST) directional gate on the execution timeframe,
 * then gates on SMC confluence scoring before emitting a signal.
 *
 * Emits enriched metadata (atrValue, regime, closeTime) consumed by the
 * TradePlanner and SignalAllocator downstream.
 */
export class MtfSmcStrategyModule extends StrategyModule {
  constructor(ctx: StrategyContext) {
    super(ctx);
  }

  public getName(): string {
    return 'MtfSmcStrategy';
  }

  public onKline(candle: Candle): SignalPayload | OrderRequestedPayload | null {
    const timeframes: MtfSmcTf[] = ['1d', '4h', '1h', '15m', '5m'];
    const candlesRecord: Partial<Record<MtfSmcTf, Candle[]>> = {};

    for (const tf of timeframes) {
      const history = this.ctx.getHistory(tf);
      if (history.length === 0) return null;
      candlesRecord[tf] = history;
    }

    const result = evaluateMtfSmcStrategy({
      candles: candlesRecord as Record<MtfSmcTf, Candle[]>,
      refPrice: candle.close,
      minConfidence: 0.65,
    });

    if (!result.pass) return null;

    const m5 = candlesRecord['5m']!;
    const h1 = candlesRecord['1h']!;

    const confluence = evaluateSmcConfluence(m5, h1, result.direction, candle.close, {
      enabled: true,
      mode: 'standard',
      standardMinScore: 3,
      sniperMinScore: 4,
      targetPct: 0.015,
    });

    if (!confluence.pass) return null;

    // ── Enrich metadata for TradePlanner + Allocator ─────────────────────
    const atrSeries = computeAtr(m5, 14);
    const atrValue = atrSeries[atrSeries.length - 1] ?? undefined;

    const st = supertrend(m5, 10, 3);
    const n = st.regime.length - 1;
    const regime = n >= 0 ? st.regime[n] : 'CHOP';

    return {
      strategyId: this.getName(),
      signal: result.direction === 'LONG' ? 'LONG' : result.direction === 'SHORT' ? 'SHORT' : 'FLAT',
      confidence: Math.min(1, confluence.score / 5),
      metadata: {
        reasons: result.reasons,
        confluenceScore: confluence.score,
        confluenceReasons: confluence.reasons,
        // Consumed by TradePlanner for ATR-based SL/TP
        atrValue: Number.isFinite(atrValue) ? atrValue : undefined,
        regime,
        // Consumed by SignalAllocator for best-of-bar bucketing
        closeTime: candle.openTime,
      },
    };
  }
}
