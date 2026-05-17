import type { Candle } from '../types';
import { ema, rsi, atr, adx } from './indicators';

export type Regime = 'TREND' | 'BREAKOUT' | 'RANGE' | 'MEAN_REVERT' | 'CHOP';

export interface RegimeSignal {
  regime: Regime;
  direction: 'LONG' | 'SHORT' | 'FLAT';
  /** Composite strength 0..1. Below 0.3 = barely classified. */
  confidence: number;
  metrics: {
    adx: number;
    plusDi: number;
    minusDi: number;
    atrPct: number;
    bbWidthPct: number;
    rsi: number;
    rocPct: number;          // 14-bar rate of change
    volZScore: number;       // volume z-score over 20 bars
    emaStackBull: boolean;
    emaStackBear: boolean;
    breakoutUp: boolean;     // close > Donchian-20 high
    breakoutDown: boolean;
  };
}

/**
 * RegimeDetector — classifies a symbol's current price action into one of
 * five regimes that map to distinct trade modes:
 *
 *   TREND       persistent direction, sized for swings
 *   BREAKOUT    fresh range break with volume, sized for scalps
 *   RANGE       contained between bands, mean-reversion at extremes
 *   MEAN_REVERT extreme RSI inside a flat ADX, fade entry
 *   CHOP        none of the above — skip
 *
 * Inputs come straight from kline history; no external state. Re-run on
 * every kline.closed and feed into AdaptiveStrategy.
 */
export class RegimeDetector {
  private lastRegime: Regime = 'CHOP';
  private lastDirection: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';

  constructor(private readonly opts: {
    adxTrend: number;          // ADX above → trend regime candidate (default 25)
    adxRange: number;          // ADX below → range candidate (default 18)
    minBars: number;           // min history required
    bbStdMultiplier: number;   // BB width multiplier (default 2)
    bbPeriod: number;          // BB lookback (default 20)
    rocPeriod: number;         // ROC lookback (default 14)
    donchianPeriod: number;    // breakout lookback (default 20)
    rsiOverbought: number;     // default 70
    rsiOversold: number;       // default 30
    volSurgeZ: number;         // default 1.5
    hysteresis: number;        // buffer for regime/signal flips (default 0.1)
  } = {
    adxTrend: 25, adxRange: 18, minBars: 60,
    bbStdMultiplier: 2, bbPeriod: 20, rocPeriod: 14,
    donchianPeriod: 20, rsiOverbought: 70, rsiOversold: 30, volSurgeZ: 1.5,
    hysteresis: 0.15,
  }) {}

  classify(candles: Candle[]): RegimeSignal {
    // ... (rest of data collection stays same)
    
    // We'll wrap the core logic and then apply hysteresis on top.
    const raw = this.classifyRaw(candles);
    
    // If the new signal is the same as the last, just return it.
    if (raw.regime === this.lastRegime && raw.direction === this.lastDirection) {
      return raw;
    }

    // Only allow a flip if the new signal's confidence is significantly high
    // or if the last signal has truly decayed.
    const flipThreshold = 0.35 + (this.opts.hysteresis || 0);
    if (raw.confidence < flipThreshold && this.lastRegime !== 'CHOP') {
        // Sticky logic: keep last regime if the new one isn't "convincing" enough to flip.
        // This stops jumping back and forth on a single RSI tick.
        return { 
            ...raw, 
            regime: this.lastRegime, 
            direction: this.lastDirection,
            confidence: Math.max(0.1, raw.confidence) 
        };
    }

    this.lastRegime = raw.regime;
    this.lastDirection = raw.direction;
    return raw;
  }

  private classifyRaw(candles: Candle[]): RegimeSignal {
    const flat: RegimeSignal = {
      regime: 'CHOP',
      direction: 'FLAT',
      confidence: 0,
      metrics: {
        adx: NaN, plusDi: NaN, minusDi: NaN, atrPct: 0, bbWidthPct: 0,
        rsi: 50, rocPct: 0, volZScore: 0,
        emaStackBull: false, emaStackBear: false,
        breakoutUp: false, breakoutDown: false,
      },
    };
    if (candles.length < this.opts.minBars) return flat;

    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1];

    const adxR = adx(candles, 14);
    const adxLast = adxR.adx[adxR.adx.length - 1];
    const pDi = adxR.plusDi[adxR.plusDi.length - 1];
    const mDi = adxR.minusDi[adxR.minusDi.length - 1];
    if (!Number.isFinite(adxLast)) return flat;

    const atrLast = atr(candles, 14).pop() ?? NaN;
    const atrPct = Number.isFinite(atrLast) && last > 0 ? atrLast / last : 0;

    const ema20 = ema(closes, 20).pop() ?? NaN;
    const ema50 = ema(closes, 50).pop() ?? NaN;
    const ema200 = ema(closes, 200).pop() ?? NaN;
    const bull = ema20 > ema50 && (Number.isFinite(ema200) ? ema50 > ema200 : true);
    const bear = ema20 < ema50 && (Number.isFinite(ema200) ? ema50 < ema200 : true);

    const rsiLast = rsi(closes, 14).pop() ?? 50;

    const rocCloses = closes.slice(-this.opts.rocPeriod - 1);
    const rocPct = rocCloses.length >= 2 && rocCloses[0] > 0
      ? ((last - rocCloses[0]) / rocCloses[0]) * 100
      : 0;

    const recent = candles.slice(-this.opts.bbPeriod);
    const mean = recent.reduce((s, c) => s + c.close, 0) / recent.length;
    const variance = recent.reduce((s, c) => s + (c.close - mean) ** 2, 0) / recent.length;
    const sd = Math.sqrt(variance);
    const bbUpper = mean + this.opts.bbStdMultiplier * sd;
    const bbLower = mean - this.opts.bbStdMultiplier * sd;
    const bbWidthPct = mean > 0 ? (bbUpper - bbLower) / mean : 0;

    const donch = candles.slice(-this.opts.donchianPeriod - 1, -1);
    const donchHi = Math.max(...donch.map((c) => c.high));
    const donchLo = Math.min(...donch.map((c) => c.low));
    const breakoutUp = last > donchHi;
    const breakoutDown = last < donchLo;

    const volumes = candles.slice(-20).map((c) => c.volume);
    const volMean = volumes.reduce((s, v) => s + v, 0) / volumes.length;
    const volVar = volumes.reduce((s, v) => s + (v - volMean) ** 2, 0) / volumes.length;
    const volSd = Math.sqrt(volVar);
    const lastVol = candles[candles.length - 1].volume;
    const volZScore = volSd > 0 ? (lastVol - volMean) / volSd : 0;

    const metrics: RegimeSignal['metrics'] = {
      adx: adxLast, plusDi: pDi, minusDi: mDi,
      atrPct, bbWidthPct, rsi: rsiLast, rocPct, volZScore,
      emaStackBull: bull, emaStackBear: bear,
      breakoutUp, breakoutDown,
    };

    // Classification priority — strongest evidence first.
    // 1. BREAKOUT: fresh donchian break + volume surge + trending DI
    if ((breakoutUp && pDi > mDi && volZScore >= this.opts.volSurgeZ) ||
        (breakoutDown && mDi > pDi && volZScore >= this.opts.volSurgeZ)) {
      return {
        regime: 'BREAKOUT',
        direction: breakoutUp ? 'LONG' : 'SHORT',
        confidence: Math.min(1, 0.5 + volZScore / 5 + Math.max(0, (adxLast - 20)) / 50),
        metrics,
      };
    }

    // 2. TREND: high ADX + aligned EMA stack
    if (adxLast >= this.opts.adxTrend) {
      if (bull && pDi > mDi) {
        return {
          regime: 'TREND', direction: 'LONG',
          confidence: Math.min(1, (adxLast - this.opts.adxTrend) / 25 + 0.4), metrics,
        };
      }
      if (bear && mDi > pDi) {
        return {
          regime: 'TREND', direction: 'SHORT',
          confidence: Math.min(1, (adxLast - this.opts.adxTrend) / 25 + 0.4), metrics,
        };
      }
    }

    // 3. MEAN_REVERT: low ADX + RSI extreme + price outside BB
    if (adxLast < this.opts.adxRange) {
      if (rsiLast >= this.opts.rsiOverbought && last >= bbUpper) {
        return { regime: 'MEAN_REVERT', direction: 'SHORT', confidence: 0.6, metrics };
      }
      if (rsiLast <= this.opts.rsiOversold && last <= bbLower) {
        return { regime: 'MEAN_REVERT', direction: 'LONG', confidence: 0.6, metrics };
      }
    }

    // 4. RANGE: low ADX + price near band edge (50/50 mean-reversion)
    if (adxLast < this.opts.adxRange) {
      if (last >= bbUpper * 0.99 && rsiLast > 55) {
        return { regime: 'RANGE', direction: 'SHORT', confidence: 0.4, metrics };
      }
      if (last <= bbLower * 1.01 && rsiLast < 45) {
        return { regime: 'RANGE', direction: 'LONG', confidence: 0.4, metrics };
      }
    }

    return { ...flat, metrics };
  }
}
