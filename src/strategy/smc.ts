import type { Candle, TrendBias } from '../types';
import { atr, swingHighsLows } from './indicators';
import { runLiquidityEngine, type LiquidityEngineResult } from './liquidity-engine';

export type SmcDirection = 'BULLISH' | 'BEARISH' | 'NONE';

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  low: number;
  high: number;
  index: number;
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  low: number;
  high: number;
  index: number;
}

/** Horizontal segment from swing bar to confirmation bar (BOS / CHoCH on chart). */
export interface SmcStructureLine {
  startIndex: number;
  endIndex: number;
  price: number;
}

export interface SmcAnalysis {
  liquiditySweep: 'LONG' | 'SHORT' | 'NONE';
  orderBlock: OrderBlock | null;
  fvg: FairValueGap | null;
  bos: SmcDirection;
  choch: SmcDirection;
  /** Swing level broken for BOS (null when `bos` is NONE). */
  bosLine: SmcStructureLine | null;
  /** Swing level broken for CHoCH (null when `choch` is NONE). */
  chochLine: SmcStructureLine | null;
  score: number;
  /** Pool registry + sweep state machine output (null only when history is too short). */
  liquidity: LiquidityEngineResult | null;
}

const SWEEP_PCT = 0.003;

const detectSweep = (candles: Candle[]): 'LONG' | 'SHORT' | 'NONE' => {
  const n = candles.length;
  if (n < 22) return 'NONE';
  const window = candles.slice(-22, -2);
  const hi = Math.max(...window.map((c) => c.high));
  const lo = Math.min(...window.map((c) => c.low));
  const a = candles[n - 2];
  const b = candles[n - 1];
  if (a.high > hi * (1 + SWEEP_PCT) && b.close < hi) return 'LONG';
  if (a.low < lo * (1 - SWEEP_PCT) && b.close > lo) return 'SHORT';
  if (b.high > hi * (1 + SWEEP_PCT) && b.close < hi) return 'LONG';
  if (b.low < lo * (1 - SWEEP_PCT) && b.close > lo) return 'SHORT';
  return 'NONE';
}

const detectOrderBlock = (candles: Candle[]): OrderBlock | null => {
  const n = candles.length;
  if (n < 20) return null;
  const a = atr(candles, 14);
  for (let i = n - 1; i >= Math.max(1, n - 10); i--) {
    const cur = candles[i];
    const atrVal = a[i];
    if (!Number.isFinite(atrVal)) continue;
    const body = Math.abs(cur.close - cur.open);
    if (body < 1.5 * atrVal) continue;
    const bullishImpulse = cur.close > cur.open;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      const prev = candles[j];
      const prevBullish = prev.close > prev.open;
      if (bullishImpulse && !prevBullish) {
        return { type: 'BULLISH', low: prev.low, high: prev.high, index: j };
      }
      if (!bullishImpulse && prevBullish) {
        return { type: 'BEARISH', low: prev.low, high: prev.high, index: j };
      }
    }
  }
  return null;
}

const detectFvg = (candles: Candle[]): FairValueGap | null => {
  const n = candles.length;
  if (n < 3) return null;
  for (let i = n - 1; i >= 2; i--) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    if (c1.high < c3.low) {
      return { type: 'BULLISH', low: c1.high, high: c3.low, index: i };
    }
    if (c1.low > c3.high) {
      return { type: 'BEARISH', low: c3.high, high: c1.low, index: i };
    }
  }
  return null;
}

const detectBosChoch = (
  candles: Candle[],
): {
  bos: SmcDirection;
  choch: SmcDirection;
  bosLine: SmcStructureLine | null;
  chochLine: SmcStructureLine | null;
} => {
  const sw = swingHighsLows(candles, 3);
  const last = candles[candles.length - 1];
  const endIndex = candles.length - 1;
  if (sw.highs.length < 2 || sw.lows.length < 2) {
    return { bos: 'NONE', choch: 'NONE', bosLine: null, chochLine: null };
  }
  const lastHigh = sw.highs[sw.highs.length - 1];
  const prevHigh = sw.highs[sw.highs.length - 2];
  const lastLow = sw.lows[sw.lows.length - 1];
  const prevLow = sw.lows[sw.lows.length - 2];

  let bos: SmcDirection = 'NONE';
  let choch: SmcDirection = 'NONE';

  if (last.close > lastHigh.price && lastHigh.price > prevHigh.price) bos = 'BULLISH';
  else if (last.close < lastLow.price && lastLow.price < prevLow.price) bos = 'BEARISH';

  if (last.close > lastHigh.price && lastLow.price < prevLow.price) choch = 'BULLISH';
  else if (last.close < lastLow.price && lastHigh.price > prevHigh.price) choch = 'BEARISH';

  let bosLine: SmcStructureLine | null = null;
  let chochLine: SmcStructureLine | null = null;
  if (bos === 'BULLISH') {
    bosLine = { startIndex: lastHigh.index, endIndex, price: lastHigh.price };
  } else if (bos === 'BEARISH') {
    bosLine = { startIndex: lastLow.index, endIndex, price: lastLow.price };
  }
  if (choch === 'BULLISH') {
    chochLine = { startIndex: lastHigh.index, endIndex, price: lastHigh.price };
  } else if (choch === 'BEARISH') {
    chochLine = { startIndex: lastLow.index, endIndex, price: lastLow.price };
  }

  return { bos, choch, bosLine, chochLine };
}

export const analyzeSmc = (candles: Candle[], _currentPrice: number, htfTrend: TrendBias, opts?: { timeframe?: string }): SmcAnalysis => {
  const timeframe = opts?.timeframe ?? 'ltf';
  const liquidity = runLiquidityEngine(candles, timeframe, {});
  const legacySweep = detectSweep(candles);
  const liquiditySweep =
    liquidity.liquiditySweep !== 'NONE' ? liquidity.liquiditySweep : legacySweep;
  const orderBlock = detectOrderBlock(candles);
  const fvg = detectFvg(candles);
  const { bos, choch, bosLine, chochLine } = detectBosChoch(candles);

  let score = 0;
  if (htfTrend === 'LONG') {
    if (liquiditySweep === 'SHORT') score++;
    if (orderBlock?.type === 'BULLISH') score++;
    if (fvg?.type === 'BULLISH') score++;
    if (bos === 'BULLISH') score++;
    if (choch === 'BULLISH') score++;
  } else if (htfTrend === 'SHORT') {
    if (liquiditySweep === 'LONG') score++;
    if (orderBlock?.type === 'BEARISH') score++;
    if (fvg?.type === 'BEARISH') score++;
    if (bos === 'BEARISH') score++;
    if (choch === 'BEARISH') score++;
  }

  const liquidityPayload =
    liquidity.pools.length > 0 || liquidity.events.length > 0 ? liquidity : null;

  return {
    liquiditySweep,
    orderBlock,
    fvg,
    bos,
    choch,
    bosLine,
    chochLine,
    score,
    liquidity: liquidityPayload,
  };
}
