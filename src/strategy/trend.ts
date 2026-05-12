import type { Candle, TrendBias } from '../types';
import {
  ema,
  rsi,
  macd,
  supertrend,
  swingStructure,
  volumeConfirms,
} from './indicators';

export interface TrendSignals {
  ema: TrendBias;
  macd: TrendBias;
  rsi: TrendBias;
  supertrend: TrendBias;
  structure: TrendBias;
  volume: boolean;
}

export interface TrendAnalysis {
  direction: TrendBias;
  confidence: number;
  score: number;
  signals: TrendSignals;
}

export interface AnalyzeTrendOpts {
  emaFast?: number;
  emaSlow?: number;
  rsiPeriod?: number;
  swingLookback?: number;
  volumeLookback?: number;
}

const lastFinite = (arr: number[]): number | null => {
  for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return arr[i];
  return null;
}

const majority = (votes: TrendBias[]): { dir: TrendBias; aligned: number } => {
  let l = 0;
  let s = 0;
  for (const v of votes) {
    if (v === 'LONG') l++;
    else if (v === 'SHORT') s++;
  }
  if (l > s) return { dir: 'LONG', aligned: l };
  if (s > l) return { dir: 'SHORT', aligned: s };
  return { dir: 'NONE', aligned: Math.max(l, s) };
}

export const analyzeTrend = (candles: Candle[], opts: AnalyzeTrendOpts = {}): TrendAnalysis => {
  const empty: TrendAnalysis = {
    direction: 'NONE',
    confidence: 0,
    score: 0,
    signals: {
      ema: 'NONE',
      macd: 'NONE',
      rsi: 'NONE',
      supertrend: 'NONE',
      structure: 'NONE',
      volume: false,
    },
  };
  if (candles.length < 30) return empty;

  const closes = candles.map((c) => c.close);
  const fast = opts.emaFast ?? 9;
  const slow = opts.emaSlow ?? 21;
  const rsiPeriod = opts.rsiPeriod ?? 14;
  const swingLb = opts.swingLookback ?? 10;
  const volLb = opts.volumeLookback ?? 20;

  const efast = ema(closes, fast);
  const eslow = ema(closes, slow);
  const fLast = lastFinite(efast);
  const sLast = lastFinite(eslow);
  let emaBias: TrendBias = 'NONE';
  if (fLast !== null && sLast !== null) {
    if (fLast > sLast) emaBias = 'LONG';
    else if (fLast < sLast) emaBias = 'SHORT';
  }

  const m = macd(closes);
  const lastHist = m.hist[m.hist.length - 1];
  const prevHist = m.hist[m.hist.length - 2];
  let macdBias: TrendBias = 'NONE';
  if (Number.isFinite(lastHist) && Number.isFinite(prevHist)) {
    if (lastHist > 0 && lastHist > prevHist) macdBias = 'LONG';
    else if (lastHist < 0 && lastHist < prevHist) macdBias = 'SHORT';
  }

  const r = rsi(closes, rsiPeriod);
  const lastR = r[r.length - 1];
  const prevR = r[r.length - 2];
  let rsiBias: TrendBias = 'NONE';
  if (Number.isFinite(lastR) && Number.isFinite(prevR)) {
    if (lastR > 45 && lastR > prevR) rsiBias = 'LONG';
    else if (lastR < 55 && lastR < prevR) rsiBias = 'SHORT';
  }

  const st = supertrend(candles);
  const stLast = st.dir[st.dir.length - 1];
  const stBias: TrendBias = stLast ?? 'NONE';

  const swing = swingStructure(candles, swingLb);
  let structBias: TrendBias = 'NONE';
  if (swing.hh && swing.hl) structBias = 'LONG';
  else if (swing.lh && swing.ll) structBias = 'SHORT';

  const volOk = volumeConfirms(candles, volLb, 0.8);

  const votes: TrendBias[] = [emaBias, macdBias, rsiBias, stBias, structBias];
  const { dir, aligned } = majority(votes);
  const directional = dir !== 'NONE' && aligned >= 4 && volOk;

  const confidence = (aligned + (volOk ? 1 : 0)) / 6;

  return {
    direction: directional ? dir : 'NONE',
    confidence,
    score: aligned,
    signals: {
      ema: emaBias,
      macd: macdBias,
      rsi: rsiBias,
      supertrend: stBias,
      structure: structBias,
      volume: volOk,
    },
  };
}
