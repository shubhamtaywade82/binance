import { atr as computeAtr } from '../../strategy/indicators';
import type { Candle } from '../../types';

export interface TradePlan {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  /** ATR-based stop. Distance = atrMult × ATR from entry. */
  stopLoss: number;
  /** Scaled TP ladder — fractions must sum to 1. */
  targets: Array<{ price: number; fraction: number }>;
  /** Weighted average reward / risk over the ladder. */
  rr: number;
  /** Unix ms at which the plan expires if not yet filled. */
  expiryMs: number;
  /** Composite quality score 0-1 used by allocator. */
  qualityScore: number;
  regime: string;
  atr: number;
  atrMult: number;
}

export interface TradePlannerConfig {
  /** Minimum acceptable reward:risk. Plans below this are dropped. Default 1.5. */
  minRR: number;
  /** Stop = atrMult × ATR from entry. Default 2.0. */
  atrMult: number;
  /** First target in R-multiples. Default 1.5. */
  tp1Mult: number;
  /** Second target in R-multiples. Default 2.5. */
  tp2Mult: number;
  /** Third target in R-multiples. Default 4.0. */
  tp3Mult: number;
  tp1Fraction: number;
  tp2Fraction: number;
  tp3Fraction: number;
  /** Cancel intent after this many bars if not filled. Default 3. */
  expiryBars: number;
  /** Milliseconds per execution bar. Default 5 m. */
  barMs: number;
}

const DEFAULTS: TradePlannerConfig = {
  minRR: 1.5,
  atrMult: 2.0,
  tp1Mult: 1.5,
  tp2Mult: 2.5,
  tp3Mult: 4.0,
  tp1Fraction: 0.40,
  tp2Fraction: 0.35,
  tp3Fraction: 0.25,
  expiryBars: 3,
  barMs: 5 * 60_000,
};

export interface PlanInput {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  confidence: number;
  regime: string;
  /** Pre-computed ATR value from the strategy (preferred). */
  atrValue?: number;
  /** Fallback: raw candles to derive ATR from. */
  candles?: Candle[];
  atrPeriod?: number;
}

const REGIME_SCORE: Record<string, number> = {
  TRENDING: 1.0,
  VOLATILE: 0.70,
  RANGING: 0.30,
  CHOP: 0.05,
};

/**
 * Convert a raw signal into a fully-specified TradePlan.
 *
 * Returns null when the plan does not meet the minimum RR threshold — the
 * caller should treat this as a soft reject and not emit an order.
 */
export const computeTradePlan = (
  input: PlanInput,
  cfg: Partial<TradePlannerConfig> = {},
): TradePlan | null => {
  const c: TradePlannerConfig = { ...DEFAULTS, ...cfg };
  const { symbol, side, entryPrice, confidence, regime } = input;

  // ── Resolve ATR ──────────────────────────────────────────────────────────
  let atrValue = input.atrValue;
  if (!atrValue || !Number.isFinite(atrValue) || atrValue <= 0) {
    const period = input.atrPeriod ?? 14;
    if (!input.candles || input.candles.length < period + 1) return null;
    const series = computeAtr(input.candles, period);
    const last = series[series.length - 1];
    if (!Number.isFinite(last) || last <= 0) return null;
    atrValue = last;
  }

  // ── SL + TP ladder ───────────────────────────────────────────────────────
  const stopDist = c.atrMult * atrValue;
  const dir = side === 'LONG' ? 1 : -1;
  const stopLoss = entryPrice - dir * stopDist;

  const targets: TradePlan['targets'] = [
    { price: entryPrice + dir * stopDist * c.tp1Mult, fraction: c.tp1Fraction },
    { price: entryPrice + dir * stopDist * c.tp2Mult, fraction: c.tp2Fraction },
    { price: entryPrice + dir * stopDist * c.tp3Mult, fraction: c.tp3Fraction },
  ];

  // ── RR gate ──────────────────────────────────────────────────────────────
  const weightedTargetDist = targets.reduce(
    (sum, t) => sum + Math.abs(t.price - entryPrice) * t.fraction,
    0,
  );
  const rr = weightedTargetDist / stopDist;
  if (rr < c.minRR) return null;

  // ── Quality score 0-1 (used by allocator for best-of-bar ranking) ────────
  const regimeFit = REGIME_SCORE[regime.toUpperCase()] ?? 0.1;
  const normalizedRR = Math.min(1, rr / 4);
  const qualityScore =
    normalizedRR * 0.35 +
    Math.min(1, confidence) * 0.30 +
    regimeFit * 0.25 +
    // Small bonus for richer RR contribution beyond the threshold
    Math.min(0.10, Math.max(0, (rr - c.minRR) / 10));

  return {
    tradeId: `plan-${symbol}-${Date.now()}`,
    symbol,
    side,
    entryPrice,
    stopLoss,
    targets,
    rr,
    expiryMs: Date.now() + c.expiryBars * c.barMs,
    qualityScore,
    regime,
    atr: atrValue,
    atrMult: c.atrMult,
  };
};
