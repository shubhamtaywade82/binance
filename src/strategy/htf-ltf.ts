import type { Candle, TrendBias } from '../types';

const closes = (candles: Candle[]): number[] => {
  return candles.map((c) => c.close).filter(Number.isFinite);
}

export const emaLast = (values: number[], period: number): number | null => {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export const emaBias = (closesArr: number[], fast = 9, slow = 21): TrendBias => {
  const ef = emaLast(closesArr, fast);
  const es = emaLast(closesArr, slow);
  if (ef === null || es === null) return 'NONE';
  if (ef > es) return 'LONG';
  if (ef < es) return 'SHORT';
  return 'NONE';
}

export const biasFromCandles = (candles: Candle[]): TrendBias => {
  const c = closes(candles);
  if (c.length < 21) return 'NONE';
  return emaBias(c);
}

export const alignedTrend = (htf: TrendBias, ltf: TrendBias): TrendBias => {
  if (htf === 'LONG' && ltf === 'LONG') return 'LONG';
  if (htf === 'SHORT' && ltf === 'SHORT') return 'SHORT';
  return 'NONE';
}
