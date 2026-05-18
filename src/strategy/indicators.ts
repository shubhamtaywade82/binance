import type { Candle } from '../types';

export const emaSeries = (values: number[], period: number): number[] => {
  return ema(values, period);
}

export const ema = (values: number[], period: number): number[] => {
  const out: number[] = [];
  if (values.length === 0 || period <= 0) return out;
  const k = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      seedSum += values[i];
      if (i === period - 1) {
        prev = seedSum / period;
        out.push(prev);
      } else {
        out.push(NaN);
      }
      continue;
    }
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export const rsi = (closes: number[], period = 14): number[] => {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  hist: number[];
}

export const macd = (closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult => {
  const efast = ema(closes, fast);
  const eslow = ema(closes, slow);
  const macdLine: number[] = closes.map((_, i) =>
    Number.isFinite(efast[i]) && Number.isFinite(eslow[i]) ? efast[i] - eslow[i] : NaN,
  );
  // Signal EMA on macd line, but only over valid (post-slow) section.
  const macdValid: number[] = [];
  let firstValid = -1;
  for (let i = 0; i < macdLine.length; i++) {
    if (Number.isFinite(macdLine[i])) {
      if (firstValid < 0) firstValid = i;
      macdValid.push(macdLine[i]);
    }
  }
  const sigValid = ema(macdValid, signalPeriod);
  const signal: number[] = new Array(closes.length).fill(NaN);
  if (firstValid >= 0) {
    for (let j = 0; j < sigValid.length; j++) signal[firstValid + j] = sigValid[j];
  }
  const hist = macdLine.map((m, i) =>
    Number.isFinite(m) && Number.isFinite(signal[i]) ? m - signal[i] : NaN,
  );
  return { macd: macdLine, signal, hist };
}

export const atr = (candles: Candle[], period = 14): number[] => {
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      trs.push(candles[i].high - candles[i].low);
      continue;
    }
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
    trs.push(tr);
  }
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  out[period - 1] = sum / period;
  for (let i = period; i < trs.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

/**
 * Wilder ADX / DMI.
 * Returns three series aligned to `candles`. Values are NaN until
 * 2*period bars have been processed (DI smoothing + ADX smoothing).
 */
export const adx = (candles: Candle[], period = 14): AdxResult => {
  const n = candles.length;
  const plusDi = new Array(n).fill(NaN);
  const minusDi = new Array(n).fill(NaN);
  const adxArr = new Array(n).fill(NaN);
  if (n <= period * 2) return { adx: adxArr, plusDi, minusDi };

  const tr: number[] = new Array(n).fill(0);
  const plusDm: number[] = new Array(n).fill(0);
  const minusDm: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
  }

  // Wilder smoothing
  let trSum = 0, plusSum = 0, minusSum = 0;
  for (let i = 1; i <= period; i++) {
    trSum += tr[i];
    plusSum += plusDm[i];
    minusSum += minusDm[i];
  }
  let smTr = trSum, smPlus = plusSum, smMinus = minusSum;
  const dx: number[] = new Array(n).fill(NaN);
  plusDi[period] = smTr === 0 ? 0 : (100 * smPlus) / smTr;
  minusDi[period] = smTr === 0 ? 0 : (100 * smMinus) / smTr;
  const sum = plusDi[period] + minusDi[period];
  dx[period] = sum === 0 ? 0 : (100 * Math.abs(plusDi[period] - minusDi[period])) / sum;

  for (let i = period + 1; i < n; i++) {
    smTr = smTr - smTr / period + tr[i];
    smPlus = smPlus - smPlus / period + plusDm[i];
    smMinus = smMinus - smMinus / period + minusDm[i];
    plusDi[i] = smTr === 0 ? 0 : (100 * smPlus) / smTr;
    minusDi[i] = smTr === 0 ? 0 : (100 * smMinus) / smTr;
    const s = plusDi[i] + minusDi[i];
    dx[i] = s === 0 ? 0 : (100 * Math.abs(plusDi[i] - minusDi[i])) / s;
  }

  // ADX = Wilder average of DX over `period`
  let adxStart = period * 2;
  if (adxStart >= n) return { adx: adxArr, plusDi, minusDi };
  let dxSum = 0;
  for (let i = period + 1; i <= adxStart; i++) dxSum += dx[i];
  adxArr[adxStart] = dxSum / period;
  for (let i = adxStart + 1; i < n; i++) {
    adxArr[i] = (adxArr[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { adx: adxArr, plusDi, minusDi };
};

export interface SupertrendResult {
  value: number[];
  dir: ('LONG' | 'SHORT')[];
  buySignal: boolean[];
  sellSignal: boolean[];
  regime: ('TRENDING' | 'VOLATILE' | 'RANGING' | 'CHOP')[];
  score: number[];
}

export interface SupertrendOptions {
  adxPeriod?: number;
  adxTrendingThreshold?: number;
  atrRegimeLookback?: number;
  minMultiplier?: number;
  maxMultiplier?: number;
  volatilityExpansionFactor?: number;
  rangingCompressionFactor?: number;
  chopFactor?: number;
  cooldownBars?: number;
  minSignalScore?: number;
  wickMode?: boolean;
}

export const supertrend = (
  candles: Candle[],
  period = 10,
  mult = 3,
  options: SupertrendOptions = {},
): SupertrendResult => {
  const n = candles.length;
  const value: number[] = new Array(n).fill(NaN);
  const dir: ('LONG' | 'SHORT')[] = new Array(n).fill('LONG');
  const buySignal = new Array(n).fill(false);
  const sellSignal = new Array(n).fill(false);
  const regime: ('TRENDING' | 'VOLATILE' | 'RANGING' | 'CHOP')[] = new Array(n).fill('CHOP');
  const score = new Array(n).fill(0);
  if (n <= period) return { value, dir, buySignal, sellSignal, regime, score };

  const adxPeriod = Math.max(2, Math.floor(options.adxPeriod ?? 14));
  const adxTrendingThreshold = options.adxTrendingThreshold ?? 25;
  const atrRegimeLookback = Math.max(5, Math.floor(options.atrRegimeLookback ?? 50));
  const minMultiplier = Math.max(0.5, options.minMultiplier ?? 1);
  const maxMultiplier = Math.max(minMultiplier, options.maxMultiplier ?? 5);
  const volatilityExpansionFactor = Math.max(1, options.volatilityExpansionFactor ?? 1.6);
  const rangingCompressionFactor = Math.max(0.2, options.rangingCompressionFactor ?? 0.75);
  const chopFactor = Math.max(0.5, options.chopFactor ?? 1.15);
  const cooldownBars = Math.max(0, Math.floor(options.cooldownBars ?? 3));
  const minSignalScore = Math.max(0, Math.min(100, options.minSignalScore ?? 65));
  const wickMode = options.wickMode ?? true;

  const a = atr(candles, period);
  const adxRes = adx(candles, adxPeriod);
  const volumeSma20 = ema(candles.map((c) => c.volume), 20);
  let finalUpper = NaN;
  let finalLower = NaN;
  let prevDir: 'LONG' | 'SHORT' = 'LONG';
  let lastSignalIndex = -Infinity;

  for (let i = period; i < n; i++) {
    const c = candles[i];
    const atrLookbackStart = Math.max(period - 1, i - atrRegimeLookback + 1);
    let atrAvg = 0;
    let atrCount = 0;
    for (let j = atrLookbackStart; j <= i; j++) {
      if (Number.isFinite(a[j])) {
        atrAvg += a[j];
        atrCount++;
      }
    }
    atrAvg = atrCount > 0 ? atrAvg / atrCount : a[i];
    const atrRatio = atrAvg > 0 ? a[i] / atrAvg : 1;
    const adxVal = Number.isFinite(adxRes.adx[i]) ? adxRes.adx[i] : 0;

    let adaptiveMult = mult;
    if (adxVal >= adxTrendingThreshold && atrRatio >= 0.8 && atrRatio <= 1.2) {
      regime[i] = 'TRENDING';
    } else if (atrRatio > 1.3) {
      regime[i] = 'VOLATILE';
      adaptiveMult *= volatilityExpansionFactor;
    } else if (adxVal < adxTrendingThreshold && atrRatio < 0.95) {
      regime[i] = 'RANGING';
      adaptiveMult *= rangingCompressionFactor;
    } else {
      regime[i] = 'CHOP';
      adaptiveMult *= chopFactor;
    }
    adaptiveMult = Math.max(minMultiplier, Math.min(maxMultiplier, adaptiveMult));

    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + adaptiveMult * a[i];
    const basicLower = hl2 - adaptiveMult * a[i];
    if (i === period) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      prevDir = c.close > basicUpper ? 'LONG' : 'SHORT';
    } else {
      const prevClose = candles[i - 1].close;
      finalUpper =
        basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower =
        basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;
      const brokeLower = wickMode ? c.low < finalLower : c.close < finalLower;
      const brokeUpper = wickMode ? c.high > finalUpper : c.close > finalUpper;
      if (prevDir === 'LONG' && brokeLower) prevDir = 'SHORT';
      else if (prevDir === 'SHORT' && brokeUpper) prevDir = 'LONG';
    }
    const flipped = i > period && dir[i - 1] !== prevDir;

    const volBase = volumeSma20[i];
    const volRatio = Number.isFinite(volBase) && volBase > 0 ? c.volume / volBase : 1;
    const displacement = a[i] > 0 ? Math.abs(c.close - (prevDir === 'LONG' ? finalUpper : finalLower)) / a[i] : 0;
    const htfBiasScore = prevDir === 'LONG'
      ? (Number.isFinite(adxRes.plusDi[i]) && adxRes.plusDi[i] > adxRes.minusDi[i] ? 20 : 0)
      : (Number.isFinite(adxRes.minusDi[i]) && adxRes.minusDi[i] > adxRes.plusDi[i] ? 20 : 0);
    const regimeScore = regime[i] === 'TRENDING' ? 15 : regime[i] === 'VOLATILE' ? 10 : regime[i] === 'CHOP' ? 5 : 2;
    const adxScore = Math.min(10, Math.max(0, (adxVal / 40) * 10));
    score[i] = Math.round(
      Math.min(15, Math.max(0, (volRatio - 0.6) * 25)) +
      Math.min(20, displacement * 8) +
      htfBiasScore +
      regimeScore +
      adxScore +
      (prevDir === 'LONG' && c.close > c.open ? 8 : prevDir === 'SHORT' && c.close < c.open ? 8 : 0),
    );

    if (flipped && i - lastSignalIndex >= cooldownBars && score[i] >= minSignalScore) {
      if (prevDir === 'LONG') buySignal[i] = true;
      else sellSignal[i] = true;
      lastSignalIndex = i;
    }

    dir[i] = prevDir;
    value[i] = prevDir === 'LONG' ? finalLower : finalUpper;
  }
  return { value, dir, buySignal, sellSignal, regime, score };
}

export interface SwingStructure {
  hh: boolean;
  hl: boolean;
  lh: boolean;
  ll: boolean;
}

export const swingStructure = (candles: Candle[], lookback = 10): SwingStructure => {
  const empty = { hh: false, hl: false, lh: false, ll: false };
  if (candles.length < lookback * 2) return empty;
  const last = candles.slice(-lookback);
  const prior = candles.slice(-lookback * 2, -lookback);
  const lastHigh = Math.max(...last.map((c) => c.high));
  const lastLow = Math.min(...last.map((c) => c.low));
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const priorLow = Math.min(...prior.map((c) => c.low));
  return {
    hh: lastHigh > priorHigh,
    hl: lastLow > priorLow,
    lh: lastHigh < priorHigh,
    ll: lastLow < priorLow,
  };
}

export interface SwingPoints {
  highs: { index: number; price: number }[];
  lows: { index: number; price: number }[];
}

export const swingHighsLows = (candles: Candle[], lookback = 5): SwingPoints => {
  const highs: { index: number; price: number }[] = [];
  const lows: { index: number; price: number }[] = [];
  const n = candles.length;
  if (n < lookback * 2 + 1) return { highs, lows };
  for (let i = lookback; i < n - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: c.high });
    if (isLow) lows.push({ index: i, price: c.low });
  }
  return { highs, lows };
}

export const volumeConfirms = (candles: Candle[], lookback = 20, threshold = 0.8): boolean => {
  if (candles.length < lookback + 1) return false;
  const recent = candles.slice(-lookback - 1, -1);
  const avg = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const last = candles[candles.length - 1].volume;
  if (avg <= 0) return false;
  return last / avg >= threshold;
}
