import type { Candle, TrendBias } from '../types';
import { atr, ema } from './indicators';

export interface StructurePoint {
  price: number;
  index: number;
  term: 'ST' | 'MT' | 'LT';
  feat1: number; // relATR
  feat2: number; // relVol
  score: number;
}

export interface LineMetadata {
  startIndex: number;
  startPrice: number;
  cumVol: number;
  cumDelta: number;
  fillRatio: number;
}

export interface KnnArchitectureResult {
  stLines: { high: number | null, low: number | null };
  mtLines: { high: number | null, low: number | null };
  ltLines: { high: number | null, low: number | null };
  stBOS: { index: number, price: number, type: 'BULLISH' | 'BEARISH' }[];
  mtBOS: { index: number, price: number, type: 'BULLISH' | 'BEARISH' }[];
  ltBOS: { index: number, price: number, type: 'BULLISH' | 'BEARISH' }[];
  deltaTanks: { price: number, type: 'HIGH' | 'LOW', delta: number, volume: number, ratio: number }[];
  volumeProfile: { price: number, volume: number, isPoc: boolean }[];
  bias: TrendBias;
  confidence: number;
  points: StructurePoint[];
}

export const analyzeKnnArchitecture = (candles: Candle[], sensitivity = 5, knnK = 5, minConfidence = 0.4): KnnArchitectureResult => {
  const n = candles.length;
  const result: KnnArchitectureResult = {
    stLines: { high: null, low: null },
    mtLines: { high: null, low: null },
    ltLines: { high: null, low: null },
    stBOS: [], mtBOS: [], ltBOS: [],
    deltaTanks: [],
    volumeProfile: [],
    bias: 'NONE',
    confidence: 0,
    points: []
  };

  if (n < 50) return result;

  // 1. Dynamic Sensitivity
  const atr200 = atr(candles, 200);
  const avgAtr200 = movingAverage(atr200, 200);
  const lastAtr = atr200[n - 1] || 0;
  const lastAvgAtr = avgAtr200[n - 1] || lastAtr;
  const volRatio = lastAtr / (lastAvgAtr || 1);
  const smoothedRatio = ema([volRatio], 50)[0] || volRatio; 
  
  const dynamicMultiplier = Math.pow(smoothedRatio, 1.5);
  const baseLen = Math.max(3, Math.round((11 - sensitivity) * dynamicMultiplier));

  // Features preparation
  const atr14 = atr(candles, 14);
  const avgAtr14 = movingAverage(atr14, 100);
  const volumes = candles.map(c => c.volume);
  const avgVol = movingAverage(volumes, 100);

  // 2. Pivot Detection & kNN Validation
  const historyHigh: StructurePoint[] = [];
  const historyLow: StructurePoint[] = [];

  const processTerm = (len: number, term: 'ST' | 'MT' | 'LT') => {
    let lastHigh: number | null = null;
    let lastLow: number | null = null;
    const bos: { index: number, price: number, type: 'BULLISH' | 'BEARISH' }[] = [];

    // We scan history to build kNN database and find active lines
    for (let i = len; i < n - len; i++) {
      const isPH = candles.slice(i - len, i + len + 1).every(c => c.high <= candles[i].high);
      const isPL = candles.slice(i - len, i + len + 1).every(c => c.low >= candles[i].low);

      if (isPH) {
        const feat1 = atr14[i] / (avgAtr14[i] || 1);
        const feat2 = volumes[i] / (avgVol[i] || 1);
        const current: StructurePoint = { price: candles[i].high, index: i, term, feat1, feat2, score: 1.0 };
        
        if (knnScore(current, historyHigh, knnK) >= minConfidence) {
          lastHigh = current.price;
          result.points.push(current);
        }
        historyHigh.push(current);
        if (historyHigh.length > 100) historyHigh.shift();
      }

      if (isPL) {
        const feat1 = atr14[i] / (avgAtr14[i] || 1);
        const feat2 = volumes[i] / (avgVol[i] || 1);
        const current: StructurePoint = { price: candles[i].low, index: i, term, feat1, feat2, score: 1.0 };
        
        if (knnScore(current, historyLow, knnK) >= minConfidence) {
          lastLow = current.price;
          result.points.push(current);
        }
        historyLow.push(current);
        if (historyLow.length > 100) historyLow.shift();
      }

      // BOS Check
      if (lastHigh && candles[i].close > lastHigh) {
        bos.push({ index: i, price: lastHigh, type: 'BULLISH' });
        lastHigh = null;
      }
      if (lastLow && candles[i].close < lastLow) {
        bos.push({ index: i, price: lastLow, type: 'BEARISH' });
        lastLow = null;
      }
    }
    return { lastHigh, lastLow, bos };
  };

  const st = processTerm(baseLen, 'ST');
  const mt = processTerm(baseLen * 3, 'MT');
  const lt = processTerm(baseLen * 9, 'LT');

  result.stLines = { high: st.lastHigh, low: st.lastLow };
  result.mtLines = { high: mt.lastHigh, low: mt.lastLow };
  result.ltLines = { high: lt.lastHigh, low: lt.lastLow };
  result.stBOS = st.bos.slice(-5);
  result.mtBOS = mt.bos.slice(-3);
  result.ltBOS = lt.bos.slice(-2);

  // 3. Delta Tank & Volume Profile
  const activeHigh = result.ltLines.high || result.mtLines.high || result.stLines.high;
  const activeLow = result.ltLines.low || result.mtLines.low || result.stLines.low;

  if (activeHigh && activeLow) {
    // Delta Tank
    let cumVolHigh = 0, cumDeltaHigh = 0;
    let cumVolLow = 0, cumDeltaLow = 0;
    
    // Scan last 50 bars for accumulation near active levels
    for (let i = n - 50; i < n; i++) {
      const c = candles[i];
      const delta = c.close > c.open ? c.volume : -c.volume;
      if (Math.abs(c.high - activeHigh) / activeHigh < 0.002) {
        cumVolHigh += c.volume;
        cumDeltaHigh += delta;
      }
      if (Math.abs(c.low - activeLow) / activeLow < 0.002) {
        cumVolLow += c.volume;
        cumDeltaLow += delta;
      }
    }

    if (cumVolHigh > 0) {
      result.deltaTanks.push({ price: activeHigh, type: 'HIGH', delta: cumDeltaHigh, volume: cumVolHigh, ratio: cumDeltaHigh / cumVolHigh });
    }
    if (cumVolLow > 0) {
      result.deltaTanks.push({ price: activeLow, type: 'LOW', delta: cumDeltaLow, volume: cumVolLow, ratio: cumDeltaLow / cumVolLow });
    }

    // Volume Profile (Anchored)
    const rows = 30;
    const step = (activeHigh - activeLow) / rows;
    const bins = new Array(rows).fill(0);
    for (let i = n - 100; i < n; i++) {
      const c = candles[i];
      if (c.close >= activeLow && c.close <= activeHigh) {
        const binIdx = Math.min(rows - 1, Math.floor((c.close - activeLow) / step));
        bins[binIdx] += c.volume;
      }
    }
    const maxBin = Math.max(...bins);
    result.volumeProfile = bins.map((v, i) => ({
      price: activeLow + i * step + step / 2,
      volume: v,
      isPoc: v === maxBin && v > 0
    }));

    // Bias
    const lastClose = candles[n - 1].close;
    if (lastClose > activeHigh) result.bias = 'LONG';
    else if (lastClose < activeLow) result.bias = 'SHORT';
    else result.bias = 'NONE';
  }

  return result;
};

const movingAverage = (values: (number | null | undefined)[], period: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += (values[i - j] || 0);
    }
    out.push(sum / period);
  }
  return out;
};

const knnScore = (current: StructurePoint, history: StructurePoint[], k: number): number => {
  if (history.length < k) return 0.5;
  const distances = history.map(p => ({
    dist: Math.abs(current.feat1 - p.feat1) + Math.abs(current.feat2 - p.feat2),
    score: p.score
  }));
  distances.sort((a, b) => a.dist - b.dist);
  const nearest = distances.slice(0, k);
  return nearest.reduce((sum, p) => sum + p.score, 0) / k;
};
