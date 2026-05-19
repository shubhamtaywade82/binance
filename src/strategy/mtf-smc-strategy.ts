import type { Candle, TrendBias } from '../types';
import { biasFromCandles } from './htf-ltf';
import { analyzeSmc, type SmcAnalysis } from './smc';
import { analyzeTrend } from './trend';
import { emaTrend } from './smc-confluence';
import { supertrend } from './indicators';

export type MtfSmcTf = '1d' | '4h' | '1h' | '15m' | '5m';

export const MTF_SMC_TIMEFRAMES: MtfSmcTf[] = ['1d', '4h', '1h', '15m', '5m'];

export interface MtfSmcStrategyInput {
  candles: Record<MtfSmcTf, Candle[]>;
  refPrice: number;
  minConfidence: number;
}

export interface MtfSmcStrategyResult {
  pass: boolean;
  direction: TrendBias;
  reasons: string[];
}

const MIN_D1 = 22;
const MIN_H4 = 30;
const MIN_STACK = 30;

const bosMatchesDirection = (smc: SmcAnalysis, dir: TrendBias): boolean => {
  if (dir === 'LONG') return smc.bos === 'BULLISH';
  if (dir === 'SHORT') return smc.bos === 'BEARISH';
  return false;
}

const chochMatchesDirection = (smc: SmcAnalysis, dir: TrendBias): boolean => {
  if (dir === 'LONG') return smc.choch === 'BULLISH';
  if (dir === 'SHORT') return smc.choch === 'BEARISH';
  return false;
}

const structureGate = (smc: SmcAnalysis, dir: TrendBias): boolean => {
  return bosMatchesDirection(smc, dir) || chochMatchesDirection(smc, dir);
}

const setupHits = (candles: Candle[], refPrice: number, dir: TrendBias): number => {
  if (candles.length < MIN_STACK) return 0;
  const smc = analyzeSmc(candles, refPrice, dir);
  let hits = 0;
  if (dir === 'LONG' && smc.orderBlocks.some(ob => ob.type === 'BULLISH')) hits++;
  if (dir === 'SHORT' && smc.orderBlocks.some(ob => ob.type === 'BEARISH')) hits++;
  const sweepOk =
    (dir === 'LONG' && smc.liquiditySweep === 'SHORT') ||
    (dir === 'SHORT' && smc.liquiditySweep === 'LONG');
  if (sweepOk) hits++;
  if (structureGate(smc, dir)) hits++;
  return hits;
}

const pdhPdlFilter = (dir: TrendBias, refPrice: number, d1: Candle[]): boolean => {
  const last = d1[d1.length - 1];
  if (!last) return false;
  if (dir === 'LONG' && refPrice >= last.high * 0.985) return false;
  if (dir === 'SHORT' && refPrice <= last.low * 1.015) return false;
  return true;
}

/**
 * Adaptive Supertrend gate on the execution timeframe (5m).
 * Blocks entries when the ADST direction conflicts with the intended trade
 * direction or when the regime is pure CHOP (no trend momentum present).
 * Falls through permissively when there are fewer than 30 bars.
 */
const adstGate = (candles: Candle[], dir: TrendBias): boolean => {
  if (candles.length < 30) return true;
  const st = supertrend(candles, 10, 3);
  const n = st.dir.length - 1;
  const stDir = st.dir[n];
  const stRegime = st.regime[n];
  if (stDir !== dir) return false;
  if (stRegime === 'CHOP') return false;
  return true;
}

export const evaluateMtfSmcStrategy = (input: MtfSmcStrategyInput): MtfSmcStrategyResult => {
  const reasons: string[] = [];
  const { candles, refPrice, minConfidence } = input;
  const d1 = candles['1d'];
  const h4 = candles['4h'];
  const h1 = candles['1h'];
  const m15 = candles['15m'];
  const m5 = candles['5m'];

  if (d1.length < MIN_D1) {
    return { pass: false, direction: 'NONE', reasons: ['daily_insufficient_bars'] };
  }
  const dailyBias = biasFromCandles(d1);
  if (dailyBias === 'NONE') {
    return { pass: false, direction: 'NONE', reasons: ['daily_bias_none'] };
  }
  reasons.push(`daily_${dailyBias}`);

  if (h4.length < MIN_H4 || h1.length < MIN_STACK || m15.length < MIN_STACK || m5.length < MIN_STACK) {
    return { pass: false, direction: dailyBias, reasons: [...reasons, 'mtf_insufficient_bars'] };
  }

  const dir = dailyBias;

  const h4Ema = emaTrend(h4);
  if (h4Ema !== dir) {
    return { pass: false, direction: dir, reasons: [...reasons, 'h4_ema_mismatch'] };
  }
  reasons.push('h4_ema_aligned');

  const h4Smc = analyzeSmc(h4, refPrice, dir);
  if (!bosMatchesDirection(h4Smc, dir)) {
    return { pass: false, direction: dir, reasons: [...reasons, 'h4_bos_fail'] };
  }
  reasons.push('h4_bos_ok');

  const h1Hits = setupHits(h1, refPrice, dir);
  if (h1Hits < 2) {
    return { pass: false, direction: dir, reasons: [...reasons, 'h1_setup_weak'] };
  }
  reasons.push('h1_setup_ok');

  const m15Hits = setupHits(m15, refPrice, dir);
  if (m15Hits < 2) {
    return { pass: false, direction: dir, reasons: [...reasons, 'm15_setup_weak'] };
  }
  reasons.push('m15_setup_ok');

  const ltfTrend = analyzeTrend(m5);
  if (ltfTrend.direction !== dir || ltfTrend.confidence < minConfidence) {
    return { pass: false, direction: dir, reasons: [...reasons, 'm5_trend_fail'] };
  }
  reasons.push('m5_trend_ok');

  const m5Smc = analyzeSmc(m5, refPrice, dir);
  if (!structureGate(m5Smc, dir)) {
    return { pass: false, direction: dir, reasons: [...reasons, 'm5_structure_trigger_fail'] };
  }
  reasons.push('m5_trigger_ok');

  if (!adstGate(m5, dir)) {
    return { pass: false, direction: dir, reasons: [...reasons, 'adst_conflict'] };
  }
  reasons.push('adst_aligned');

  if (!pdhPdlFilter(dir, refPrice, d1)) {
    return { pass: false, direction: dir, reasons: [...reasons, 'pdh_pdl_zone_risk'] };
  }

  return { pass: true, direction: dir, reasons };
}

// Backward-compat aliases — orchestrator, dashboard, and tests import these names.
export type SolMtfTf = MtfSmcTf;
export const SOL_MTF_TIMEFRAMES = MTF_SMC_TIMEFRAMES;
export type SolMtfStrategyInput = MtfSmcStrategyInput;
export type SolMtfStrategyResult = MtfSmcStrategyResult;
export const evaluateSolMtfStrategy = evaluateMtfSmcStrategy;
