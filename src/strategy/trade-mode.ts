import type { Regime } from './regime-detector';

export interface TpRung {
  /** Price move from entry in percent (positive = favorable). */
  pricePct: number;
  /** Fraction of original qty to close at this rung (0..1). Sum must be ≤ 1. */
  fraction: number;
}

export interface TradeModeProfile {
  id: 'SWING' | 'BREAKOUT_SCALP' | 'RANGE_FADE' | 'MEAN_REVERT';
  /** Fraction of equity risked. e.g. 0.005 = 0.5%. */
  riskPct: number;
  /** Leverage applied on order. */
  leverage: number;
  /** Initial stop as ATR multiplier. */
  atrStopMult: number;
  /** TP ladder. Last rung typically closes remainder OR leaves residual for trail. */
  tpLadder: TpRung[];
  /** Enable Chandelier trail after all ladder rungs hit (or always run). */
  trailAfterLadder: boolean;
  /** Hold-time cap in execution-TF bars (used by TimeStopManager fallback). 0=unlimited. */
  maxHoldBars: number;
  /** Min confidence from RegimeDetector to take the trade. */
  minRegimeConfidence: number;
  /** Free notes for logs/UI. */
  description: string;
}

/**
 * Default mode catalog — tuned for crypto perp paper-trading on 5m execution TF
 * with 1h HTF bias. Tune via env JSON overrides (TRADE_MODES_OVERRIDE_JSON).
 *
 * Ladders are absolute % of price, NOT R-multiples — easier for operators to
 * reason about ("close 30% at +5%") and matches the user-asked-for cadence
 * (5/10/15/20). For breakout scalps the ladder is tighter; for swings it's
 * wider and lets the final chunk run with the trail.
 */
export const DEFAULT_MODES: Record<Regime, TradeModeProfile | null> = {
  TREND: {
    id: 'SWING',
    riskPct: 0.0075,
    leverage: 10,
    atrStopMult: 3,
    tpLadder: [
      { pricePct: 5,  fraction: 0.25 },
      { pricePct: 10, fraction: 0.25 },
      { pricePct: 15, fraction: 0.25 },
      // remaining 25% rides the Chandelier trail
    ],
    trailAfterLadder: true,
    maxHoldBars: 0,
    minRegimeConfidence: 0.5,
    description: 'Trend-following swing — 5/10/15% partials + trail residual',
  },

  BREAKOUT: {
    id: 'BREAKOUT_SCALP',
    riskPct: 0.005,
    leverage: 10,
    atrStopMult: 2,
    tpLadder: [
      { pricePct: 1,  fraction: 0.40 },
      { pricePct: 2,  fraction: 0.30 },
      { pricePct: 4,  fraction: 0.20 },
      // remaining 10% rides trail
    ],
    trailAfterLadder: true,
    maxHoldBars: 12, // 1h on 5m TF
    minRegimeConfidence: 0.6,
    description: 'Donchian breakout scalp — fast partials, tight trail',
  },

  RANGE: {
    id: 'RANGE_FADE',
    riskPct: 0.003,
    leverage: 10,
    atrStopMult: 1.5,
    tpLadder: [
      { pricePct: 0.8, fraction: 0.5 },
      { pricePct: 1.5, fraction: 0.5 }, // closes remainder
    ],
    trailAfterLadder: false,
    maxHoldBars: 12,
    minRegimeConfidence: 0.4,
    description: 'Range fade — small target, half/half, no trail',
  },

  MEAN_REVERT: {
    id: 'MEAN_REVERT',
    riskPct: 0.0025,
    leverage: 10,
    atrStopMult: 1.5,
    tpLadder: [
      { pricePct: 0.5, fraction: 0.5 },
      { pricePct: 1.0, fraction: 0.5 },
    ],
    trailAfterLadder: false,
    maxHoldBars: 6,
    minRegimeConfidence: 0.5,
    description: 'RSI extreme fade — tight target, exit quickly',
  },

  CHOP: null,
};

export const pickMode = (regime: Regime, overrides?: Partial<Record<Regime, TradeModeProfile | null>>): TradeModeProfile | null => {
  const merged = { ...DEFAULT_MODES, ...(overrides || {}) };
  return merged[regime] ?? null;
};
