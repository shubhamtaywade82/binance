import type { Candle, TrendBias } from '../types';
import { atr } from './indicators';
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
  /** Current structural bias */
  trend: 'bullish' | 'bearish' | 'range';
  /** Detected market structure pivots */
  structPoints: StructurePoint[];
  /** Cleaned swing points */
  swings: SwingPoint[];
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

export interface SwingPoint {
  kind: 'high' | 'low';
  price: number;
  index: number;
  time: number;
}

export interface StructurePoint {
  label: 'hh' | 'hl' | 'lh' | 'll';
  swing: SwingPoint;
}

class SwingDetector {
  constructor(private candles: Candle[], private left = 3, private right = 3) {}

  detect(): SwingPoint[] {
    const swings: SwingPoint[] = [];
    const n = this.candles.length;
    if (n < this.left + this.right + 1) return swings;

    for (let i = this.left; i < n - this.right; i++) {
      const pivot = this.candles[i];
      let isHigh = true;
      let isLow = true;

      for (let j = i - this.left; j < i; j++) {
        if (pivot.high <= this.candles[j].high) isHigh = false;
        if (pivot.low >= this.candles[j].low) isLow = false;
      }
      
      for (let j = i + 1; j <= i + this.right; j++) {
        if (pivot.high < this.candles[j].high) isHigh = false;
        if (pivot.low > this.candles[j].low) isLow = false;
      }

      if (isHigh) {
        swings.push({ kind: 'high', price: pivot.high, index: i, time: pivot.openTime });
      }
      if (isLow) {
        swings.push({ kind: 'low', price: pivot.low, index: i, time: pivot.openTime });
      }
    }
    return swings.sort((a, b) => a.index - b.index);
  }
}

class SwingSequenceCleaner {
  constructor(private swings: SwingPoint[]) {}

  clean(): SwingPoint[] {
    const result: SwingPoint[] = [];
    for (const swing of this.swings) {
      if (result.length === 0) {
        result.push(swing);
        continue;
      }
      const prev = result[result.length - 1];
      if (prev.kind === swing.kind) {
        if (swing.kind === 'high' && swing.price > prev.price) {
          result[result.length - 1] = swing;
        } else if (swing.kind === 'low' && swing.price < prev.price) {
          result[result.length - 1] = swing;
        }
      } else {
        result.push(swing);
      }
    }
    return result;
  }
}

class MarketStructureLabeler {
  constructor(private swings: SwingPoint[]) {}

  label(): StructurePoint[] {
    const result: StructurePoint[] = [];
    let prevHigh: SwingPoint | null = null;
    let prevLow: SwingPoint | null = null;

    for (const swing of this.swings) {
      if (swing.kind === 'high') {
        if (prevHigh) {
          result.push({
            label: swing.price > prevHigh.price ? 'hh' : 'lh',
            swing
          });
        }
        prevHigh = swing;
      }
      if (swing.kind === 'low') {
        if (prevLow) {
          result.push({
            label: swing.price > prevLow.price ? 'hl' : 'll',
            swing
          });
        }
        prevLow = swing;
      }
    }
    return result;
  }
}

class StructureTrendDetector {
  constructor(private points: StructurePoint[]) {}

  currentBias(): 'bullish' | 'bearish' | 'range' {
    const last = this.points.slice(-4).map(p => p.label);
    if (last.includes('hh') && last.includes('hl')) return 'bullish';
    if (last.includes('lh') && last.includes('ll')) return 'bearish';
    return 'range';
  }
}

class BosChochDetector {
  constructor(
    private candles: Candle[],
    private cleanSwings: SwingPoint[],
    private trend: 'bullish' | 'bearish' | 'range'
  ) {}

  detect(): { bos: SmcDirection; choch: SmcDirection; bosLine: SmcStructureLine | null; chochLine: SmcStructureLine | null } {
    let bos: SmcDirection = 'NONE';
    let choch: SmcDirection = 'NONE';
    let bosLine: SmcStructureLine | null = null;
    let chochLine: SmcStructureLine | null = null;

    if (this.cleanSwings.length < 2) {
      return { bos, choch, bosLine, chochLine };
    }

    const lastHighs = this.cleanSwings.filter(s => s.kind === 'high');
    const lastLows = this.cleanSwings.filter(s => s.kind === 'low');
    
    const lastHigh = lastHighs.length > 0 ? lastHighs[lastHighs.length - 1] : null;
    const lastLow = lastLows.length > 0 ? lastLows[lastLows.length - 1] : null;

    if (!lastHigh || !lastLow) return { bos, choch, bosLine, chochLine };

    const findBreakout = (startIdx: number, price: number, isBullish: boolean): number | null => {
      for (let i = startIdx + 1; i < this.candles.length; i++) {
        if (isBullish && this.candles[i].close > price) return i;
        if (!isBullish && this.candles[i].close < price) return i;
      }
      return null;
    };

    if (this.trend === 'bullish') {
      const breakIdx = findBreakout(lastHigh.index, lastHigh.price, true);
      if (breakIdx !== null) {
        bos = 'BULLISH';
        bosLine = { startIndex: lastHigh.index, endIndex: breakIdx, price: lastHigh.price };
      }
    } else if (this.trend === 'bearish') {
      const breakIdx = findBreakout(lastLow.index, lastLow.price, false);
      if (breakIdx !== null) {
        bos = 'BEARISH';
        bosLine = { startIndex: lastLow.index, endIndex: breakIdx, price: lastLow.price };
      }
    }

    if (this.trend === 'bearish' || this.trend === 'range') {
      const breakIdx = findBreakout(lastHigh.index, lastHigh.price, true);
      if (breakIdx !== null) {
        choch = 'BULLISH';
        chochLine = { startIndex: lastHigh.index, endIndex: breakIdx, price: lastHigh.price };
      }
    }
    
    if (this.trend === 'bullish' || this.trend === 'range') {
      const breakIdx = findBreakout(lastLow.index, lastLow.price, false);
      if (breakIdx !== null) {
        choch = 'BEARISH';
        chochLine = { startIndex: lastLow.index, endIndex: breakIdx, price: lastLow.price };
      }
    }

    return { bos, choch, bosLine, chochLine };
  }
}

const detectBosChoch = (
  candles: Candle[],
): {
  bos: SmcDirection;
  choch: SmcDirection;
  bosLine: SmcStructureLine | null;
  chochLine: SmcStructureLine | null;
  trend: 'bullish' | 'bearish' | 'range';
  structPoints: StructurePoint[];
  swings: SwingPoint[];
} => {
  const detector = new SwingDetector(candles, 3, 3);
  const rawSwings = detector.detect();
  
  const cleaner = new SwingSequenceCleaner(rawSwings);
  const cleanSwings = cleaner.clean();
  
  const labeler = new MarketStructureLabeler(cleanSwings);
  const structPoints = labeler.label();
  
  const trendDetector = new StructureTrendDetector(structPoints);
  const bias = trendDetector.currentBias();
  
  const breakDetector = new BosChochDetector(candles, cleanSwings, bias);
  const breaks = breakDetector.detect();
  return { ...breaks, trend: bias, structPoints, swings: cleanSwings };
}

export const analyzeSmc = (candles: Candle[], _currentPrice: number, htfTrend: TrendBias, opts?: { timeframe?: string }): SmcAnalysis => {
  const timeframe = opts?.timeframe ?? 'ltf';
  const liquidity = runLiquidityEngine(candles, timeframe, {});
  const legacySweep = detectSweep(candles);
  const liquiditySweep =
    liquidity.liquiditySweep !== 'NONE' ? liquidity.liquiditySweep : legacySweep;
  const orderBlock = detectOrderBlock(candles);
  const fvg = detectFvg(candles);
  const { bos, choch, bosLine, chochLine, trend, structPoints, swings } = detectBosChoch(candles);

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
    trend,
    structPoints,
    swings,
    score,
    liquidity: liquidityPayload,
  };
}
