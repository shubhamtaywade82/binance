import type { Candle, TrendBias } from '../types';
import { atr, ema } from './indicators';

export interface StructurePoint {
  price: number;
  index: number;
  term: 'ST' | 'MT' | 'LT';
  feat1: number;
  feat2: number;
  score: number;
}

export interface ActiveLevel {
  price: number;
  formIndex: number;
  kind: 'high' | 'low';
  term: 'ST' | 'MT' | 'LT';
}

export interface DeltaTank {
  price: number;
  type: 'HIGH' | 'LOW';
  term: 'ST' | 'MT' | 'LT';
  delta: number;
  volume: number;
  ratio: number;
}

export interface TermLines {
  high: number | null;
  highIndex: number | null;
  low: number | null;
  lowIndex: number | null;
}

export interface BosEvent {
  index: number;
  price: number;
  type: 'BULLISH' | 'BEARISH';
  fromIndex: number;
}

export interface KnnArchitectureResult {
  stLines: TermLines;
  mtLines: TermLines;
  ltLines: TermLines;
  stBOS: BosEvent[];
  mtBOS: BosEvent[];
  ltBOS: BosEvent[];
  deltaTanks: DeltaTank[];
  volumeProfile: { price: number; volume: number; isPoc: boolean }[];
  bias: TrendBias;
  confidence: number;
  points: StructurePoint[];
  activeLevels: ActiveLevel[];
}

export type BiasSource = 'AUTO' | 'ST' | 'MT' | 'LT';

interface TermResult {
  lastHigh: number | null;
  lastHighIndex: number | null;
  lastLow: number | null;
  lastLowIndex: number | null;
  bos: BosEvent[];
  activeLevels: ActiveLevel[];
}

const EMPTY_RESULT: KnnArchitectureResult = {
  stLines: { high: null, highIndex: null, low: null, lowIndex: null },
  mtLines: { high: null, highIndex: null, low: null, lowIndex: null },
  ltLines: { high: null, highIndex: null, low: null, lowIndex: null },
  stBOS: [], mtBOS: [], ltBOS: [],
  deltaTanks: [],
  volumeProfile: [],
  bias: 'NONE',
  confidence: 0,
  points: [],
  activeLevels: [],
};

export const analyzeKnnArchitecture = (
  candles: Candle[],
  sensitivity = 5,
  knnK = 5,
  minConfidence = 0.4,
  biasSource: BiasSource = 'AUTO',
): KnnArchitectureResult => {
  const n = candles.length;
  if (n < 50) return { ...EMPTY_RESULT };

  const dynamicLen = computeDynamicBaseLen(candles, sensitivity);
  const atr14 = atr(candles, 14);
  const avgAtr14 = sma(atr14, 100);
  const volumes = candles.map(c => c.volume);
  const avgVol = sma(volumes, 100);

  const featureAt = (i: number): [number, number] => [
    atr14[i] / (avgAtr14[i] || 1),
    volumes[i] / (avgVol[i] || 1),
  ];

  const st = processTerm(candles, dynamicLen, 'ST', knnK, minConfidence, featureAt);
  const mt = processTerm(candles, dynamicLen * 3, 'MT', knnK, minConfidence, featureAt);
  const lt = processTerm(candles, dynamicLen * 9, 'LT', knnK, minConfidence, featureAt);

  const allActiveLevels = [...st.activeLevels, ...mt.activeLevels, ...lt.activeLevels];

  const biasLines = resolveBiasLines(biasSource, st, mt, lt);
  const activeHigh = biasLines.high;
  const activeLow = biasLines.low;
  const activeHighIdx = biasLines.highIndex;
  const activeLowIdx = biasLines.lowIndex;

  const deltaTanks = computeDeltaTanks(candles, allActiveLevels);

  const volumeProfile = (activeHigh != null && activeLow != null && activeHigh > activeLow)
    ? computeAnchoredVolumeProfile(candles, activeLow, activeHigh, activeHighIdx, activeLowIdx)
    : [];

  const bias = computeBias(candles, activeHigh, activeLow);
  const confidence = computeConfidence(candles, activeHigh, activeLow);

  return {
    stLines: { high: st.lastHigh, highIndex: st.lastHighIndex, low: st.lastLow, lowIndex: st.lastLowIndex },
    mtLines: { high: mt.lastHigh, highIndex: mt.lastHighIndex, low: mt.lastLow, lowIndex: mt.lastLowIndex },
    ltLines: { high: lt.lastHigh, highIndex: lt.lastHighIndex, low: lt.lastLow, lowIndex: lt.lastLowIndex },
    stBOS: st.bos.slice(-5),
    mtBOS: mt.bos.slice(-3),
    ltBOS: lt.bos.slice(-2),
    deltaTanks,
    volumeProfile,
    bias,
    confidence,
    points: [],
    activeLevels: allActiveLevels,
  };
};

function computeDynamicBaseLen(candles: Candle[], sensitivity: number): number {
  const n = candles.length;
  const atr14 = atr(candles, 14);
  const longAvg = sma(atr14, 200);

  const ratios: number[] = [];
  for (let i = 200; i < n; i++) {
    const a = atr14[i];
    const la = longAvg[i];
    if (Number.isFinite(a) && Number.isFinite(la) && la > 0) {
      ratios.push(a / la);
    }
  }

  const smoothed = ratios.length > 0
    ? ema(ratios, Math.min(50, ratios.length))[ratios.length - 1] || 1
    : 1;

  const multiplier = Math.pow(Math.max(0.5, Math.min(3.0, smoothed)), 1.5);
  return Math.max(3, Math.round((11 - sensitivity) * multiplier));
}

function processTerm(
  candles: Candle[],
  len: number,
  term: 'ST' | 'MT' | 'LT',
  knnK: number,
  minConfidence: number,
  featureAt: (i: number) => [number, number],
): TermResult {
  const n = candles.length;
  const historyHigh: StructurePoint[] = [];
  const historyLow: StructurePoint[] = [];

  let lastHigh: number | null = null;
  let lastHighIndex: number | null = null;
  let lastLow: number | null = null;
  let lastLowIndex: number | null = null;
  const bos: BosEvent[] = [];
  const activeLevels: ActiveLevel[] = [];

  if (len >= Math.floor(n / 2)) {
    return { lastHigh, lastHighIndex, lastLow, lastLowIndex, bos, activeLevels };
  }

  for (let i = len; i < n - len; i++) {
    const isPH = isPivotHigh(candles, i, len);
    const isPL = isPivotLow(candles, i, len);

    if (isPH) {
      const [f1, f2] = featureAt(i);
      const point: StructurePoint = { price: candles[i].high, index: i, term, feat1: f1, feat2: f2, score: 0 };
      const score = knnValidate(point, historyHigh, knnK);
      point.score = score;

      if (score >= minConfidence) {
        lastHigh = point.price;
        lastHighIndex = i;
      }
      historyHigh.push(point);
      if (historyHigh.length > 150) historyHigh.shift();
    }

    if (isPL) {
      const [f1, f2] = featureAt(i);
      const point: StructurePoint = { price: candles[i].low, index: i, term, feat1: f1, feat2: f2, score: 0 };
      const score = knnValidate(point, historyLow, knnK);
      point.score = score;

      if (score >= minConfidence) {
        lastLow = point.price;
        lastLowIndex = i;
      }
      historyLow.push(point);
      if (historyLow.length > 150) historyLow.shift();
    }

    if (lastHigh != null && lastHighIndex != null && candles[i].close > lastHigh) {
      bos.push({ index: i, price: lastHigh, type: 'BULLISH', fromIndex: lastHighIndex });
      retroScoreNeighbors(historyHigh, lastHigh, true);
      lastHigh = null;
      lastHighIndex = null;
    }
    if (lastLow != null && lastLowIndex != null && candles[i].close < lastLow) {
      bos.push({ index: i, price: lastLow, type: 'BEARISH', fromIndex: lastLowIndex });
      retroScoreNeighbors(historyLow, lastLow, true);
      lastLow = null;
      lastLowIndex = null;
    }
  }

  if (lastHigh != null && lastHighIndex != null) {
    activeLevels.push({ price: lastHigh, formIndex: lastHighIndex, kind: 'high', term });
  }
  if (lastLow != null && lastLowIndex != null) {
    activeLevels.push({ price: lastLow, formIndex: lastLowIndex, kind: 'low', term });
  }

  return { lastHigh, lastHighIndex, lastLow, lastLowIndex, bos, activeLevels };
}

function isPivotHigh(candles: Candle[], i: number, len: number): boolean {
  const pivot = candles[i].high;
  for (let j = i - len; j <= i + len; j++) {
    if (j === i) continue;
    if (candles[j].high > pivot) return false;
  }
  return true;
}

function isPivotLow(candles: Candle[], i: number, len: number): boolean {
  const pivot = candles[i].low;
  for (let j = i - len; j <= i + len; j++) {
    if (j === i) continue;
    if (candles[j].low < pivot) return false;
  }
  return true;
}

/**
 * kNN validation: score is the weighted-average outcome of the k nearest
 * historical pivots (by feature distance). Pivots that later led to a BOS
 * get score 1 (successful structural level); pivots that held get 0.5 (neutral);
 * unresolved pivots start at 0.5 and are retroactively updated.
 */
function knnValidate(current: StructurePoint, history: StructurePoint[], k: number): number {
  if (history.length < k) return 0.5;

  const scored: { dist: number; score: number }[] = [];
  for (const p of history) {
    const d1 = current.feat1 - p.feat1;
    const d2 = current.feat2 - p.feat2;
    const dist = Math.sqrt(d1 * d1 + d2 * d2);
    scored.push({ dist, score: p.score });
  }
  scored.sort((a, b) => a.dist - b.dist);

  const neighbors = scored.slice(0, k);
  const totalInvDist = neighbors.reduce((s, n) => s + 1 / (n.dist + 1e-8), 0);

  let weightedSum = 0;
  for (const nb of neighbors) {
    const w = (1 / (nb.dist + 1e-8)) / totalInvDist;
    weightedSum += w * nb.score;
  }
  return weightedSum;
}

/**
 * After a BOS, retroactively score recent pivots at that price level.
 * Pivots near the broken level that DID produce a BOS = successful (score → 1.0).
 * Other pivots at different prices decay toward 0.3 (weaker structural levels).
 */
function retroScoreNeighbors(history: StructurePoint[], brokenPrice: number, wasBroken: boolean): void {
  const tolerance = brokenPrice * 0.003;
  for (let i = history.length - 1; i >= Math.max(0, history.length - 20); i--) {
    const p = history[i];
    if (Math.abs(p.price - brokenPrice) <= tolerance) {
      p.score = wasBroken ? 1.0 : 0.3;
    } else if (p.score === 0) {
      p.score = 0.5;
    }
  }
}

function resolveBiasLines(
  biasSource: BiasSource,
  st: TermResult,
  mt: TermResult,
  lt: TermResult,
): { high: number | null; low: number | null; highIndex: number | null; lowIndex: number | null } {
  const pick = (term: TermResult) => ({
    high: term.lastHigh,
    low: term.lastLow,
    highIndex: term.lastHighIndex,
    lowIndex: term.lastLowIndex,
  });

  if (biasSource === 'LT' && (lt.lastHigh != null || lt.lastLow != null)) return pick(lt);
  if (biasSource === 'MT' && (mt.lastHigh != null || mt.lastLow != null)) return pick(mt);
  if (biasSource === 'ST' && (st.lastHigh != null || st.lastLow != null)) return pick(st);

  if (lt.lastHigh != null || lt.lastLow != null) return pick(lt);
  if (mt.lastHigh != null || mt.lastLow != null) return pick(mt);
  return pick(st);
}

function computeDeltaTanks(candles: Candle[], activeLevels: ActiveLevel[]): DeltaTank[] {
  const n = candles.length;
  const tanks: DeltaTank[] = [];

  for (const level of activeLevels) {
    const startBar = Math.max(0, level.formIndex);
    let cumVol = 0;
    let cumDelta = 0;

    for (let i = startBar; i < n; i++) {
      const c = candles[i];
      const priceProximity = Math.abs(
        (level.kind === 'high' ? c.high : c.low) - level.price,
      ) / level.price;

      if (priceProximity < 0.003) {
        const delta = c.close > c.open ? c.volume : -c.volume;
        cumVol += c.volume;
        cumDelta += delta;
      }
    }

    if (cumVol > 0) {
      tanks.push({
        price: level.price,
        type: level.kind === 'high' ? 'HIGH' : 'LOW',
        term: level.term,
        delta: cumDelta,
        volume: cumVol,
        ratio: cumDelta / cumVol,
      });
    }
  }
  return tanks;
}

function computeAnchoredVolumeProfile(
  candles: Candle[],
  low: number,
  high: number,
  highIdx: number | null,
  lowIdx: number | null,
): { price: number; volume: number; isPoc: boolean }[] {
  const rows = 30;
  const range = high - low;
  if (range <= 0) return [];
  const step = range / rows;
  const bins = new Array<number>(rows).fill(0);

  const anchorStart = Math.max(0, Math.min(highIdx ?? 0, lowIdx ?? 0));
  const n = candles.length;

  for (let i = anchorStart; i < n; i++) {
    const c = candles[i];
    if (c.close >= low && c.close <= high) {
      const idx = Math.min(rows - 1, Math.floor((c.close - low) / step));
      bins[idx] += c.volume;
    }
  }

  const maxBin = Math.max(...bins);
  return bins.map((v, i) => ({
    price: low + i * step + step / 2,
    volume: v,
    isPoc: v === maxBin && v > 0,
  }));
}

function computeBias(candles: Candle[], high: number | null, low: number | null): TrendBias {
  if (high == null || low == null) return 'NONE';
  const lastClose = candles[candles.length - 1].close;
  if (lastClose > high) return 'LONG';
  if (lastClose < low) return 'SHORT';
  return 'NONE';
}

function computeConfidence(candles: Candle[], high: number | null, low: number | null): number {
  if (high == null || low == null || high <= low) return 0;
  const lastClose = candles[candles.length - 1].close;
  const range = high - low;
  const position = (lastClose - low) / range;
  return Math.max(0, Math.min(1, Math.abs(position - 0.5) * 2));
}

function sma(values: (number | null | undefined)[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  let count = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const num = (v != null && Number.isFinite(v)) ? v : 0;

    sum += num;
    count++;

    if (count > period) {
      const old = values[i - period];
      sum -= (old != null && Number.isFinite(old)) ? old : 0;
      count--;
    }

    out.push(count >= period ? sum / period : NaN);
  }
  return out;
}
