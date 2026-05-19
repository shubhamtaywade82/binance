/**
 * Streaming TA primitives. Each function takes a closed-candle series and
 * returns an aligned series of the same length (with NaN where the indicator
 * isn't yet defined).
 */

import type { Candle } from '../provider-client';

export const ema = (values: number[], period: number): number[] => {
  if (period <= 0 || values.length === 0) return values.map(() => NaN);
  const out: number[] = new Array(values.length);
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]!;
    if (i === 0) prev = v;
    else prev = v * k + prev * (1 - k);
    out[i] = i >= period - 1 ? prev : NaN;
  }
  return out;
};

export const sma = (values: number[], period: number): number[] => {
  const out: number[] = new Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out[i] = i >= period - 1 ? sum / period : NaN;
  }
  return out;
};

export const stdev = (values: number[], period: number): number[] => {
  const out: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) { out[i] = NaN; continue; }
    let mean = 0;
    for (let j = i - period + 1; j <= i; j += 1) mean += values[j]!;
    mean /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j += 1) v += (values[j]! - mean) ** 2;
    out[i] = Math.sqrt(v / period);
  }
  return out;
};

export const rsi = (values: number[], period = 14): number[] => {
  const out: number[] = new Array(values.length).fill(NaN);
  if (values.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i]! - values[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i]! - values[i - 1]!;
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
};

export interface MacdOutput {
  macd: number[];
  signal: number[];
  hist: number[];
}

export const macd = (values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdOutput => {
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const macdLine = values.map((_, i) => ef[i]! - es[i]!);
  const signal = ema(macdLine.map((v) => Number.isFinite(v) ? v : 0), signalPeriod);
  const hist = macdLine.map((v, i) => v - signal[i]!);
  return { macd: macdLine, signal, hist };
};

export interface BollingerOutput {
  middle: number[];
  upper: number[];
  lower: number[];
}

export const bollinger = (values: number[], period = 20, mult = 2): BollingerOutput => {
  const middle = sma(values, period);
  const sd = stdev(values, period);
  const upper = middle.map((m, i) => m + mult * sd[i]!);
  const lower = middle.map((m, i) => m - mult * sd[i]!);
  return { middle, upper, lower };
};

/**
 * Session VWAP — anchors at the start of each UTC trading day.
 */
export const vwap = (candles: Candle[]): number[] => {
  const out: number[] = new Array(candles.length).fill(NaN);
  let dayKey = '';
  let cumPv = 0;
  let cumVol = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]!;
    const key = new Date(c.openTime).toISOString().slice(0, 10);
    if (key !== dayKey) {
      dayKey = key;
      cumPv = 0;
      cumVol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPv += typical * c.volume;
    cumVol += c.volume;
    out[i] = cumVol > 0 ? cumPv / cumVol : NaN;
  }
  return out;
};
