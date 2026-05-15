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
}

export const supertrend = (candles: Candle[], period = 10, mult = 3): SupertrendResult => {
  const n = candles.length;
  const value: number[] = new Array(n).fill(NaN);
  const dir: ('LONG' | 'SHORT')[] = new Array(n).fill('LONG');
  if (n <= period) return { value, dir };
  const a = atr(candles, period);
  let finalUpper = NaN;
  let finalLower = NaN;
  let prevDir: 'LONG' | 'SHORT' = 'LONG';
  for (let i = period; i < n; i++) {
    const c = candles[i];
    const hl2 = (c.high + c.low) / 2;
    const basicUpper = hl2 + mult * a[i];
    const basicLower = hl2 - mult * a[i];
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
      if (prevDir === 'LONG' && c.close < finalLower) prevDir = 'SHORT';
      else if (prevDir === 'SHORT' && c.close > finalUpper) prevDir = 'LONG';
    }
    dir[i] = prevDir;
    value[i] = prevDir === 'LONG' ? finalLower : finalUpper;
  }
  return { value, dir };
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
