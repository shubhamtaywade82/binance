/**
 * Swing strategy for tier=`swing` symbols.
 *
 * Simpler than the SOL-MTF scalp stack:
 *   1. HTF bias must be LONG or SHORT (EMA-9/21 on HTF).
 *   2. Latest LTF close must be a displacement candle in the bias direction.
 *      Displacement = body fraction >= 0.6 and range >= 1.3x ATR(14).
 *   3. Price must be at or just past an aligned FVG (or aligned bullish/bearish OB)
 *      from the LTF SMC analysis (retracement entry).
 *   4. Confidence is a weighted score over (1)+(2)+(3); rejects below `minConfidence`.
 *
 * Microstructure gating is intentionally skipped — swing entries trade across
 * many hours, so spread/TFI/cancel-intensity noise is not predictive.
 */
import type { Candle, Side } from '../types';
import { biasFromCandles } from './htf-ltf';
import { analyzeSmc } from './smc';
import type { TradeAttribution } from '../execution/types';

export interface SwingStrategyInput {
  symbol: string;
  candlesLtf: Candle[];
  candlesHtf: Candle[];
  refPrice?: number;
  minConfidence: number;
}

export interface SwingStrategyResult {
  side: Side;
  confidence: number;
  attribution: TradeAttribution;
}

const MIN_LTF = 30;
const MIN_HTF = 21;

const atr = (candles: Candle[], period = 14): number => {
  if (candles.length < period + 1) return 0;
  const slice = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const c = slice[i];
    const prev = slice[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    sum += tr;
  }
  return sum / period;
};

interface DisplacementCheck {
  ok: boolean;
  side: Side | null;
  bodyFrac: number;
  rangeAtr: number;
}

const checkDisplacement = (candles: Candle[]): DisplacementCheck => {
  if (candles.length < MIN_LTF) return { ok: false, side: null, bodyFrac: 0, rangeAtr: 0 };
  const last = candles[candles.length - 1];
  const range = last.high - last.low;
  if (range <= 0) return { ok: false, side: null, bodyFrac: 0, rangeAtr: 0 };
  const body = Math.abs(last.close - last.open);
  const bodyFrac = body / range;
  const a = atr(candles, 14);
  const rangeAtr = a > 0 ? range / a : 0;
  const ok = bodyFrac >= 0.6 && rangeAtr >= 1.3;
  if (!ok) return { ok, side: null, bodyFrac, rangeAtr };
  const side: Side = last.close > last.open ? 'LONG' : 'SHORT';
  return { ok, side, bodyFrac, rangeAtr };
};

interface ZoneAlignment {
  ok: boolean;
  kind: 'FVG' | 'OB' | null;
}

const findAlignedZone = (
  ltf: Candle[],
  side: Side,
  refPrice: number,
): ZoneAlignment => {
  const smc = analyzeSmc(ltf, refPrice, side);
  const wantType = side === 'LONG' ? 'BULLISH' : 'BEARISH';
  const fvg = smc.fvgs.find((f) => f.type === wantType && refPrice >= f.low && refPrice <= f.high);
  if (fvg) return { ok: true, kind: 'FVG' };
  const ob = smc.orderBlocks.find(
    (o) =>
      o.type === wantType &&
      !o.isInvalidated &&
      refPrice >= o.low &&
      refPrice <= o.high,
  );
  if (ob) return { ok: true, kind: 'OB' };
  return { ok: false, kind: null };
};

export const evaluateSwingSignal = (input: SwingStrategyInput): SwingStrategyResult | null => {
  const { candlesLtf, candlesHtf, minConfidence } = input;
  if (candlesLtf.length < MIN_LTF || candlesHtf.length < MIN_HTF) return null;

  const htfBias = biasFromCandles(candlesHtf);
  if (htfBias === 'NONE') return null;

  const disp = checkDisplacement(candlesLtf);
  if (!disp.ok || disp.side === null || disp.side !== htfBias) return null;

  const side: Side = disp.side;
  const refPrice = input.refPrice ?? candlesLtf[candlesLtf.length - 1].close;
  const zone = findAlignedZone(candlesLtf, side, refPrice);
  if (!zone.ok) return null;

  // Score: HTF alignment baseline 0.55, +0.15 strong displacement, +0.20 zone retracement (FVG > OB).
  let confidence = 0.55;
  if (disp.rangeAtr >= 1.8) confidence += 0.15;
  else if (disp.rangeAtr >= 1.5) confidence += 0.10;
  if (zone.kind === 'FVG') confidence += 0.20;
  else if (zone.kind === 'OB') confidence += 0.15;
  if (disp.bodyFrac >= 0.75) confidence += 0.05;

  if (confidence < minConfidence) return null;

  const attribution: TradeAttribution = {
    entrySignal: `swing_${zone.kind ?? 'NONE'}`,
    smcZone: zone.kind ?? undefined,
    htfBias,
    confidence: Number(confidence.toFixed(3)),
  };

  return { side, confidence, attribution };
};

export const SWING_STRATEGY_SYMBOL_TAG = 'swing-strategy' as const;
