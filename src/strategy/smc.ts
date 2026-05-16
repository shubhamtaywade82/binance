import type { Candle, TrendBias } from '../types';
import { runLiquidityEngine, type LiquidityEngineResult } from './liquidity-engine';

export type SmcDirection = 'BULLISH' | 'BEARISH' | 'NONE';

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  low: number;
  high: number;
  index: number;
  mitigatedIndex?: number;
  invalidatedIndex?: number;
  isMitigated?: boolean;
  isInvalidated?: boolean;
  score: number;
  validation: {
    hasLiquiditySweep: boolean;
    hasDisplacement: boolean;
    hasStructureBreak: boolean;
    hasFvg: boolean;
  };
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  low: number;
  high: number;
  index: number;
  startIndex?: number;
  endIndex?: number;
  isFilled?: boolean;
  score: number;
}

export interface BreakerBlock {
  type: 'BULLISH' | 'BEARISH';
  low: number;
  high: number;
  index: number;
  mitigatedIndex?: number;
}

export interface SmcBlock {
  type: 'OB' | 'FVG' | 'BREAKER' | 'LIQUIDITY' | 'SESSION' | 'PR_DC';
  subType: string;
  low: number;
  high: number;
  startIndex: number;
  endIndex: number;
  isMitigated: boolean;
  isInvalidated: boolean;
}

export interface DealingRange {
  high: number;
  low: number;
  equilibrium: number;
}

/** Horizontal segment from swing bar to confirmation bar (BOS / CHoCH on chart). */
export interface SmcStructureLine {
  startIndex: number;
  endIndex: number;
  price: number;
}

export interface SmcAnalysis {
  liquiditySweep: 'LONG' | 'SHORT' | 'NONE';
  orderBlocks: OrderBlock[];
  fvgs: FairValueGap[];
  breakers: BreakerBlock[];
  blocks: SmcBlock[];
  dealingRange: DealingRange | null;
  bos: SmcDirection;
  choch: SmcDirection;
  bosLine: SmcStructureLine | null;
  chochLine: SmcStructureLine | null;
  idmLine: SmcStructureLine | null;
  score: number;
  liquidity: LiquidityEngineResult | null;
  trend: 'bullish' | 'bearish' | 'range';
  structPoints: StructurePoint[];
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

const detectOrderBlocks = (candles: Candle[]): OrderBlock[] => {
  const n = candles.length;
  if (n < 50) return [];
  
  const { swings } = detectBosChoch(candles);
  const obs: OrderBlock[] = [];
  const bodies = candles.map(c => Math.abs(c.close - c.open));
  
  const getAvgBody = (idx: number, len = 20) => {
    const slice = bodies.slice(Math.max(0, idx - len), idx);
    if (slice.length === 0) return 0;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };

  const lookback = Math.min(n - 10, 150);
  for (let i = n - 5; i >= n - lookback; i--) {
    const cur = candles[i]!;
    const body = bodies[i]!;
    const avgBody = getAvgBody(i);
    
    const hasDisplacement = body > avgBody * 2.0;
    if (!hasDisplacement) continue;
    
    const isBullishImpulse = cur.close > cur.open;
    
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const origin = candles[j]!;
      const isOpposite = isBullishImpulse ? origin.close < origin.open : origin.close > origin.open;
      
      if (isOpposite) {
        let hasLiquiditySweep = false;
        const sweepWindow = candles.slice(Math.max(0, j - 10), j);
        if (isBullishImpulse) {
          const localMin = Math.min(...sweepWindow.map(c => c.low));
          if (origin.low < localMin) hasLiquiditySweep = true;
        } else {
          const localMax = Math.max(...sweepWindow.map(c => c.high));
          if (origin.high > localMax) hasLiquiditySweep = true;
        }

        let hasStructureBreak = false;
        const recentHighs = swings.filter(s => s.kind === 'high' && s.index < j).slice(-3);
        const recentLows = swings.filter(s => s.kind === 'low' && s.index < j).slice(-3);
        
        for (let k = i; k < Math.min(n, i + 10); k++) {
          const ck = candles[k]!;
          if (isBullishImpulse) {
            if (recentHighs.some(rh => ck.close > rh.price)) {
              hasStructureBreak = true;
              break;
            }
          } else {
            if (recentLows.some(rl => ck.close < rl.price)) {
              hasStructureBreak = true;
              break;
            }
          }
        }

        let hasFvg = false;
        if (isBullishImpulse) {
          if (i + 1 < n && candles[i - 1]!.high < candles[i + 1]!.low) hasFvg = true;
        } else {
          if (i + 1 < n && candles[i - 1]!.low > candles[i + 1]!.high) hasFvg = true;
        }

        let score = 0;
        if (hasLiquiditySweep) score += 2;
        if (hasDisplacement) score += 2;
        if (hasStructureBreak) score += 2;
        if (hasFvg) score += 1;

        const ob: OrderBlock = {
          type: isBullishImpulse ? 'BULLISH' : 'BEARISH',
          low: origin.low,
          high: origin.high,
          index: j,
          score,
          validation: {
            hasLiquiditySweep,
            hasDisplacement,
            hasStructureBreak,
            hasFvg
          }
        };
        
        let mitigated = false;
        let mitigatedIndex: number | undefined;
        let invalidated = false;
        let invalidatedIndex: number | undefined;
        for (let k = j + 1; k < n; k++) {
          const ck = candles[k]!;
          if (ob.type === 'BULLISH') {
            if (ck.low <= ob.high && !mitigated) { mitigated = true; mitigatedIndex = k; }
            if (ck.close < ob.low) { invalidated = true; invalidatedIndex = k; break; }
          } else {
            if (ck.high >= ob.low && !mitigated) { mitigated = true; mitigatedIndex = k; }
            if (ck.close > ob.high) { invalidated = true; invalidatedIndex = k; break; }
          }
        }
        
        if (!invalidated) {
          ob.isMitigated = mitigated;
          ob.mitigatedIndex = mitigatedIndex;
          obs.push(ob);
        } else {
          ob.isInvalidated = true;
          ob.invalidatedIndex = invalidatedIndex;
          obs.push(ob);
        }
        break; 
      }
    }
    if (obs.length >= 8) break;
  }
  return obs;
}

const detectFVGs = (candles: Candle[]): FairValueGap[] => {
  const n = candles.length;
  if (n < 20) return [];
  const fvgs: FairValueGap[] = [];
  const bodies = candles.map(c => Math.abs(c.close - c.open));
  
  for (let i = 2; i < n - 1; i++) {
    const c1 = candles[i - 1]!;
    const c3 = candles[i + 1]!;
    
    let type: 'BULLISH' | 'BEARISH' | null = null;
    let low = 0, high = 0;
    
    if (c1.high < c3.low) {
      type = 'BULLISH';
      low = c1.high;
      high = c3.low;
    } else if (c1.low > c3.high) {
      type = 'BEARISH';
      low = c3.high;
      high = c1.low;
    }
    
    if (type) {
      const body = bodies[i]!;
      const prevBodies = bodies.slice(Math.max(0, i - 10), i);
      const avgBody = prevBodies.reduce((a, b) => a + b, 0) / (prevBodies.length || 1);
      
      if (body > avgBody * 1.5) {
        let filled = false;
        for (let k = i + 2; k < n; k++) {
          const ck = candles[k]!;
          if (type === 'BULLISH' && ck.low <= low) filled = true;
          if (type === 'BEARISH' && ck.high >= high) filled = true;
        }
        
        if (!filled) {
          fvgs.push({ 
            type, 
            low, 
            high, 
            index: i,
            startIndex: i - 1,
            endIndex: i + 1,
            score: body > avgBody * 2.5 ? 2 : 1 
          });
        }
      }
    }
  }
  return fvgs.slice(-6);
}

const detectBreakers = (candles: Candle[], invalidatedObs: OrderBlock[]): BreakerBlock[] => {
  const n = candles.length;
  const breakers: BreakerBlock[] = [];
  for (const ob of invalidatedObs) {
    const startIdx = ob.invalidatedIndex ?? ob.index;
    const breakerType = ob.type === 'BULLISH' ? 'BEARISH' : 'BULLISH';
    let mitigatedIdx: number | undefined;
    for (let k = startIdx + 1; k < n; k++) {
      const ck = candles[k]!;
      if (breakerType === 'BULLISH' && ck.low <= ob.high) { mitigatedIdx = k; break; }
      if (breakerType === 'BEARISH' && ck.high >= ob.low) { mitigatedIdx = k; break; }
    }
    breakers.push({
      type: breakerType,
      low: ob.low,
      high: ob.high,
      index: startIdx,
      mitigatedIndex: mitigatedIdx
    });
  }
  return breakers;
}

const detectLiquidityZones = (candles: Candle[]): SmcBlock[] => {
  const n = candles.length;
  if (n < 50) return [];
  
  // Use swings instead of every candle to find meaningful liquidity
  const { swings } = detectBosChoch(candles);
  const zones: SmcBlock[] = [];
  const equalPct = 0.0006; // 0.06% tolerance

  const highSwings = swings.filter(s => s.kind === 'high').slice(-20);
  const lowSwings = swings.filter(s => s.kind === 'low').slice(-20);

  // Helper to cluster prices
  const cluster = (pts: SwingPoint[], isHigh: boolean) => {
    const used = new Set<number>();
    for (let i = 0; i < pts.length; i++) {
      if (used.has(i)) continue;
      
      const p1 = pts[i]!;
      const group = [p1];
      used.add(i);

      for (let j = i + 1; j < pts.length; j++) {
        if (used.has(j)) continue;
        const p2 = pts[j]!;
        if (Math.abs(p1.price - p2.price) / p1.price <= equalPct) {
          group.push(p2);
          used.add(j);
        }
      }

      if (group.length >= 2) {
        const prices = group.map(g => g.price);
        const indices = group.map(g => g.index);
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        
        zones.push({
          type: 'LIQUIDITY',
          subType: isHigh ? 'EQH' : 'EQL',
          low: isHigh ? avgPrice - (avgPrice * 0.0001) : Math.min(...prices) - (avgPrice * 0.0003),
          high: isHigh ? Math.max(...prices) + (avgPrice * 0.0003) : avgPrice + (avgPrice * 0.0001),
          startIndex: Math.min(...indices),
          endIndex: Math.max(...indices),
          isMitigated: false,
          isInvalidated: false
        });
      }
    }
  };

  cluster(highSwings, true);
  cluster(lowSwings, false);

  return zones.slice(-4); // Keep it clean
}

const detectSessionRanges = (candles: Candle[]): SmcBlock[] => {
  const n = candles.length;
  const zones: SmcBlock[] = [];
  let currentAsia: { start: number; high: number; low: number } | null = null;
  let currentLondon: { start: number; high: number; low: number } | null = null;
  let currentNY: { start: number; high: number; low: number } | null = null;
  
  for (let i = Math.max(0, n - 300); i < n; i++) {
    const c = candles[i]!;
    const date = new Date(c.openTime);
    const hour = date.getUTCHours();
    
    // 1. ASIA (00:00 - 06:00 UTC)
    const isAsia = hour >= 0 && hour < 6;
    if (isAsia) {
      if (!currentAsia) currentAsia = { start: i, high: c.high, low: c.low };
      else {
        currentAsia.high = Math.max(currentAsia.high, c.high);
        currentAsia.low = Math.min(currentAsia.low, c.low);
      }
    } else if (currentAsia) {
      zones.push({
        type: 'SESSION', subType: 'ASIA',
        low: currentAsia.low, high: currentAsia.high,
        startIndex: currentAsia.start, endIndex: i - 1,
        isMitigated: false, isInvalidated: false
      });
      currentAsia = null;
    }

    // 2. LONDON (07:00 - 11:00 UTC)
    const isLondon = hour >= 7 && hour < 11;
    if (isLondon) {
      if (!currentLondon) currentLondon = { start: i, high: c.high, low: c.low };
      else {
        currentLondon.high = Math.max(currentLondon.high, c.high);
        currentLondon.low = Math.min(currentLondon.low, c.low);
      }
    } else if (currentLondon) {
      zones.push({
        type: 'SESSION', subType: 'LONDON',
        low: currentLondon.low, high: currentLondon.high,
        startIndex: currentLondon.start, endIndex: i - 1,
        isMitigated: false, isInvalidated: false
      });
      currentLondon = null;
    }

    // 3. NEW YORK (12:00 - 16:00 UTC)
    const isNY = hour >= 12 && hour < 16;
    if (isNY) {
      if (!currentNY) currentNY = { start: i, high: c.high, low: c.low };
      else {
        currentNY.high = Math.max(currentNY.high, c.high);
        currentNY.low = Math.min(currentNY.low, c.low);
      }
    } else if (currentNY) {
      zones.push({
        type: 'SESSION', subType: 'NY',
        low: currentNY.low, high: currentNY.high,
        startIndex: currentNY.start, endIndex: i - 1,
        isMitigated: false, isInvalidated: false
      });
      currentNY = null;
    }
  }
  return zones;
}

const calculateDealingRange = (swings: SwingPoint[]): DealingRange | null => {
  if (swings.length < 2) return null;
  const lastHigh = swings.filter(s => s.kind === 'high').pop();
  const lastLow = swings.filter(s => s.kind === 'low').pop();
  if (!lastHigh || !lastLow) return null;
  
  return {
    high: lastHigh.price,
    low: lastLow.price,
    equilibrium: (lastHigh.price + lastLow.price) / 2
  };
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
      const pivot = this.candles[i]!;
      let isHigh = true;
      let isLow = true;

      for (let j = i - this.left; j < i; j++) {
        if (pivot.high <= this.candles[j]!.high) isHigh = false;
        if (pivot.low >= this.candles[j]!.low) isLow = false;
      }
      
      for (let j = i + 1; j <= i + this.right; j++) {
        if (pivot.high < this.candles[j]!.high) isHigh = false;
        if (pivot.low > this.candles[j]!.low) isLow = false;
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
      const prev = result[result.length - 1]!;
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

  detect(): { bos: SmcDirection; choch: SmcDirection; bosLine: SmcStructureLine | null; chochLine: SmcStructureLine | null; idmLine: SmcStructureLine | null } {
    let bos: SmcDirection = 'NONE';
    let choch: SmcDirection = 'NONE';
    let bosLine: SmcStructureLine | null = null;
    let chochLine: SmcStructureLine | null = null;
    let idmLine: SmcStructureLine | null = null;

    if (this.cleanSwings.length < 2) {
      return { bos, choch, bosLine, chochLine, idmLine };
    }

    const lastHighs = this.cleanSwings.filter(s => s.kind === 'high');
    const lastLows = this.cleanSwings.filter(s => s.kind === 'low');
    
    const lastHigh = lastHighs.length > 0 ? lastHighs[lastHighs.length - 1] : null;
    const lastLow = lastLows.length > 0 ? lastLows[lastLows.length - 1] : null;

    if (!lastHigh || !lastLow) return { bos, choch, bosLine, chochLine, idmLine };

    const findBreakout = (startIdx: number, price: number, isBullish: boolean): number | null => {
      for (let i = startIdx + 1; i < this.candles.length; i++) {
        if (isBullish && this.candles[i]!.close > price) return i;
        if (!isBullish && this.candles[i]!.close < price) return i;
      }
      return null;
    };

    if (this.trend === 'bullish') {
      const breakIdx = findBreakout(lastHigh.index, lastHigh.price, true);
      if (breakIdx !== null) {
        bos = 'BULLISH';
        bosLine = { startIndex: lastHigh.index, endIndex: breakIdx, price: lastHigh.price };
      }
      // IDM: Bullish Inducement is the recent internal swing low before lastHigh
      const idmSwing = lastLows.filter(s => s.index < lastHigh.index).pop();
      if (idmSwing) {
        const sweepIdx = findBreakout(lastHigh.index, idmSwing.price, false);
        if (sweepIdx !== null) {
          idmLine = { startIndex: idmSwing.index, endIndex: sweepIdx, price: idmSwing.price };
        } else {
          idmLine = { startIndex: idmSwing.index, endIndex: this.candles.length - 1, price: idmSwing.price };
        }
      }
    } else if (this.trend === 'bearish') {
      const breakIdx = findBreakout(lastLow.index, lastLow.price, false);
      if (breakIdx !== null) {
        bos = 'BEARISH';
        bosLine = { startIndex: lastLow.index, endIndex: breakIdx, price: lastLow.price };
      }
      // IDM: Bearish Inducement is the recent internal swing high before lastLow
      const idmSwing = lastHighs.filter(s => s.index < lastLow.index).pop();
      if (idmSwing) {
        const sweepIdx = findBreakout(lastLow.index, idmSwing.price, true);
        if (sweepIdx !== null) {
          idmLine = { startIndex: idmSwing.index, endIndex: sweepIdx, price: idmSwing.price };
        } else {
          idmLine = { startIndex: idmSwing.index, endIndex: this.candles.length - 1, price: idmSwing.price };
        }
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

    return { bos, choch, bosLine, chochLine, idmLine };
  }
}

const detectBosChoch = (
  candles: Candle[],
): {
  bos: SmcDirection;
  choch: SmcDirection;
  bosLine: SmcStructureLine | null;
  chochLine: SmcStructureLine | null;
  idmLine: SmcStructureLine | null;
  trend: 'bullish' | 'bearish' | 'range';
  structPoints: StructurePoint[];
  swings: SwingPoint[];
} => {
  const detector = new SwingDetector(candles, 10, 10);
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
  
  const allObs = detectOrderBlocks(candles);
  const orderBlocks = allObs.filter(ob => !ob.isInvalidated);
  const invalidatedObs = allObs.filter(ob => ob.isInvalidated);
  
  const fvgs = detectFVGs(candles);
  const breakers = detectBreakers(candles, invalidatedObs);
  
  const blocks: SmcBlock[] = [
    ...detectLiquidityZones(candles),
    ...detectSessionRanges(candles)
  ];
  
  const { bos, choch, bosLine, chochLine, idmLine, trend, structPoints, swings } = detectBosChoch(candles);
  const dealingRange = calculateDealingRange(swings);

  let score = 0;
  if (htfTrend === 'LONG') {
    if (liquiditySweep === 'SHORT') score++;
    if (orderBlocks.some(ob => ob.type === 'BULLISH')) score++;
    if (fvgs.some(fvg => fvg.type === 'BULLISH')) score++;
    if (bos === 'BULLISH') score++;
    if (choch === 'BULLISH') score++;
  } else if (htfTrend === 'SHORT') {
    if (liquiditySweep === 'LONG') score++;
    if (orderBlocks.some(ob => ob.type === 'BEARISH')) score++;
    if (fvgs.some(fvg => fvg.type === 'BEARISH')) score++;
    if (bos === 'BEARISH') score++;
    if (choch === 'BEARISH') score++;
  }

  const liquidityPayload =
    liquidity.pools.length > 0 || liquidity.events.length > 0 ? liquidity : null;

  return {
    liquiditySweep,
    orderBlocks,
    fvgs,
    breakers,
    blocks,
    dealingRange,
    bos,
    choch,
    bosLine,
    chochLine,
    idmLine,
    trend,
    structPoints,
    swings,
    score,
    liquidity: liquidityPayload,
  };
}
