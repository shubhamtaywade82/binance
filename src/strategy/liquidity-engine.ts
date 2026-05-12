import type { Candle } from '../types';
import { atr, swingHighsLows } from './indicators';

/** Buyside = resting liquidity above (equal highs); sellside = equal lows. */
export type LiquidityPoolKind = 'buyside' | 'sellside';

export type LiquidityPoolStatus = 'active' | 'invalidated';

export type LiquidityEventState =
  | 'PENDING'
  | 'TOUCHED'
  | 'SWEPT'
  | 'CONFIRMED'
  | 'INVALIDATED';

export type SweepOutcome = 'rejection' | 'acceptance' | 'pending';

export type LiquidityClassification = 'SWEEP_REJECTION' | 'BREAKOUT_ACCEPTANCE' | 'NONE';

export interface LiquidityPoolView {
  kind: LiquidityPoolKind;
  price: number;
  /** Bar index in `candles` where the pool was last reinforced. */
  createdBarIndex: number;
  strength: number;
  touches: number;
  timeframe: string;
  status: LiquidityPoolStatus;
}

export interface LiquidityEventView {
  poolKind: LiquidityPoolKind;
  poolPrice: number;
  state: LiquidityEventState;
  /** Bar index where raid / max penetration occurred (the sweep candle in this series). */
  sweepBarIndex: number | null;
  /** Price raid through the pool: buyside pool = UP, sellside = DOWN. */
  raidDirection: 'UP' | 'DOWN';
  /**
   * Interpreted liquidity bias after the raid window (rejection vs acceptance).
   * Rejection above buyside → BEARISH; rejection below sellside → BULLISH; acceptance inverts.
   */
  liquidityBias: 'BEARISH' | 'BULLISH';
  maxPenetrationPct: number;
  outcome: SweepOutcome;
  score: number;
  /** True when a strong opposite candle follows the raid (rejection path). */
  displacement: boolean;
}

export interface LiquidityEngineResult {
  pools: LiquidityPoolView[];
  events: LiquidityEventView[];
  /** Highest-scoring rejection among pools (for chart marker). */
  primaryRejection: LiquidityEventView | null;
  /** Highest-scoring acceptance among pools (breakout path). */
  primaryAcceptance: LiquidityEventView | null;
  classification: LiquidityClassification;
  /**
   * Buyside raid + rejection → `LONG` (same as legacy `detectSweep`).
   * Sellside raid + rejection → `SHORT`.
   */
  liquiditySweep: 'LONG' | 'SHORT' | 'NONE';
  sweepQualityScore: number;
}

export interface LiquidityEngineOptions {
  /** Relative band to merge swing highs / lows into one pool (e.g. 0.001 = 0.1%). */
  equalClusterPct: number;
  /** Minimum raid beyond pool price (fraction), e.g. 0.0003 ≈ 0.03%. */
  minRaidPct: number;
  /** Soft upper bound for “quality” penetration scoring (fraction). */
  idealPenetrationMaxPct: number;
  /** Bars after raid to judge rejection vs acceptance. */
  outcomeLookahead: number;
  /** Rolling volume average length. */
  volumeLookback: number;
  /** Volume multiple vs average for participation score. */
  volumeSpikeMult: number;
  /** Body vs ATR to count displacement on rejection leg. */
  displacementBodyAtrMult: number;
  /** Swing detector lookback for structural pools. */
  swingLookback: number;
  /** Fallback range window [fromEnd, toEnd) for session pools when swings are sparse. */
  fallbackWindowFromEnd: number;
  fallbackWindowToEnd: number;
  /** Strength decay per bar since pool creation. */
  decayPerBar: number;
}

const DEFAULT_OPTS: LiquidityEngineOptions = {
  equalClusterPct: 0.001,
  minRaidPct: 0.0003,
  idealPenetrationMaxPct: 0.004,
  outcomeLookahead: 5,
  volumeLookback: 20,
  volumeSpikeMult: 1.5,
  displacementBodyAtrMult: 0.55,
  swingLookback: 3,
  fallbackWindowFromEnd: 22,
  fallbackWindowToEnd: 2,
  decayPerBar: 0.97,
};

const mean = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

const avgVolume = (candles: Candle[], endIdx: number, lookback: number): number => {
  const start = Math.max(0, endIdx - lookback);
  const slice = candles.slice(start, endIdx);
  if (slice.length === 0) return 0;
  const s = slice.reduce((acc, c) => acc + c.volume, 0);
  return s / slice.length;
}

const clusterSwingPrices = (points: { index: number; price: number }[], equalPct: number): { meanPrice: number; maxIndex: number; touches: number }[] => {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters: { meanPrice: number; maxIndex: number; touches: number }[] = [];
  let cur: typeof sorted = [sorted[0]!];
  for (let k = 1; k < sorted.length; k++) {
    const p = sorted[k]!;
    const lo = cur[0]!.price;
    if (Math.abs(p.price - lo) / lo <= equalPct) {
      cur.push(p);
    } else {
      clusters.push({
        meanPrice: mean(cur.map((x) => x.price)),
        maxIndex: Math.max(...cur.map((x) => x.index)),
        touches: cur.length,
      });
      cur = [p];
    }
  }
  clusters.push({
    meanPrice: mean(cur.map((x) => x.price)),
    maxIndex: Math.max(...cur.map((x) => x.index)),
    touches: cur.length,
  });
  return clusters.filter((c) => c.touches >= 2);
}

const decayedStrength = (base: number, createdIndex: number, lastIndex: number, decayPerBar: number): number => {
  const age = Math.max(0, lastIndex - createdIndex);
  return base * decayPerBar ** age;
}

const candleBody = (c: Candle): number => {
  return Math.abs(c.close - c.open);
}

const displacementAfter = (candles: Candle[], atrSeries: number[], fromBar: number, poolKind: LiquidityPoolKind, opts: LiquidityEngineOptions): boolean => {
  const n = candles.length;
  const end = Math.min(n - 1, fromBar + opts.outcomeLookahead);
  for (let j = fromBar; j <= end; j++) {
    const c = candles[j]!;
    const av = atrSeries[j];
    if (!Number.isFinite(av) || av <= 0) continue;
    const body = candleBody(c);
    if (body < opts.displacementBodyAtrMult * av) continue;
    if (poolKind === 'buyside' && c.close < c.open) return true;
    if (poolKind === 'sellside' && c.close > c.open) return true;
  }
  return false;
}

const evaluatePoolSide = (args: {
  candles: Candle[];
  atrSeries: number[];
  pool: LiquidityPoolView;
  opts: LiquidityEngineOptions;
  scanFrom: number;
}): LiquidityEventView | null => {
  const { candles, atrSeries, pool, opts, scanFrom } = args;
  const n = candles.length;
  const P = pool.price;
  if (!Number.isFinite(P) || P <= 0) return null;

  let best: LiquidityEventView | null = null;

  for (let i = Math.max(scanFrom, 0); i < n; i++) {
    const c = candles[i]!;
    let raided = false;
    let penetrationPct = 0;
    if (pool.kind === 'buyside') {
      const minP = P * (1 + opts.minRaidPct);
      if (c.high > minP) {
        raided = true;
        penetrationPct = ((c.high - P) / P) * 100;
      }
    } else {
      const maxP = P * (1 - opts.minRaidPct);
      if (c.low < maxP) {
        raided = true;
        penetrationPct = ((P - c.low) / P) * 100;
      }
    }
    if (!raided) continue;

    const end = Math.min(n - 1, i + opts.outcomeLookahead);
    let outcome: SweepOutcome = 'pending';
    let closeAboveHold = 0;
    let closeBelowHold = 0;
    for (let j = i; j <= end; j++) {
      const cc = candles[j]!;
      if (pool.kind === 'buyside') {
        if (cc.close < P) {
          outcome = 'rejection';
          break;
        }
        if (cc.close > P) closeAboveHold++;
        else closeAboveHold = 0;
      } else {
        if (cc.close > P) {
          outcome = 'rejection';
          break;
        }
        if (cc.close < P) closeBelowHold++;
        else closeBelowHold = 0;
      }
    }
    if (outcome === 'pending' && pool.kind === 'buyside' && closeAboveHold >= 2) outcome = 'acceptance';
    if (outcome === 'pending' && pool.kind === 'sellside' && closeBelowHold >= 2) outcome = 'acceptance';

    const volAvg = avgVolume(candles, i, opts.volumeLookback);
    const volSpike = volAvg > 0 && c.volume >= volAvg * opts.volumeSpikeMult;
    const penIdeal =
      penetrationPct >= opts.minRaidPct * 100 &&
      penetrationPct <= opts.idealPenetrationMaxPct * 100;

    const disp =
      outcome === 'rejection'
        ? displacementAfter(candles, atrSeries, i, pool.kind, opts)
        : false;

    const raidDirection: 'UP' | 'DOWN' = pool.kind === 'buyside' ? 'UP' : 'DOWN';
    let liquidityBias: 'BEARISH' | 'BULLISH';
    if (outcome === 'rejection') {
      liquidityBias = pool.kind === 'buyside' ? 'BEARISH' : 'BULLISH';
    } else if (outcome === 'acceptance') {
      liquidityBias = pool.kind === 'buyside' ? 'BULLISH' : 'BEARISH';
    } else {
      liquidityBias = pool.kind === 'buyside' ? 'BEARISH' : 'BULLISH';
    }

    let score = 0;
    if (pool.touches >= 2) score += 2;
    if (penIdeal) score += 2;
    else if (penetrationPct > 0) score += 1;
    if (volSpike) score += 2;
    if (disp) score += 3;
    if (outcome === 'rejection') score += 2;
    if (outcome === 'acceptance') score += 1;

    let state: LiquidityEventState = 'PENDING';
    if (outcome === 'rejection') {
      if (score >= 6) state = 'CONFIRMED';
      else if (score >= 4) state = 'SWEPT';
      else state = 'TOUCHED';
    } else if (outcome === 'acceptance') {
      state = 'CONFIRMED';
    } else {
      state = 'TOUCHED';
    }

    const ev: LiquidityEventView = {
      poolKind: pool.kind,
      poolPrice: P,
      state,
      sweepBarIndex: i,
      raidDirection,
      liquidityBias,
      maxPenetrationPct: +penetrationPct.toFixed(4),
      outcome,
      score,
      displacement: disp,
    };

    if (!best || ev.score > best.score) best = ev;
  }

  return best;
}

export const runLiquidityEngine = (candles: Candle[], timeframeLabel: string, opts: Partial<LiquidityEngineOptions> = {}): LiquidityEngineResult => {
  const o: LiquidityEngineOptions = { ...DEFAULT_OPTS, ...opts };
  const empty: LiquidityEngineResult = {
    pools: [],
    events: [],
    primaryRejection: null,
    primaryAcceptance: null,
    classification: 'NONE',
    liquiditySweep: 'NONE',
    sweepQualityScore: 0,
  };
  const n = candles.length;
  const minBars = Math.max(22, o.fallbackWindowFromEnd + 1);
  if (n < minBars) return empty;

  const lastIdx = n - 1;
  const sw = swingHighsLows(candles, o.swingLookback);
  const highClusters = clusterSwingPrices(sw.highs, o.equalClusterPct);
  const lowClusters = clusterSwingPrices(sw.lows, o.equalClusterPct);

  const pools: LiquidityPoolView[] = [];
  for (const cl of highClusters) {
    pools.push({
      kind: 'buyside',
      price: cl.meanPrice,
      createdBarIndex: cl.maxIndex,
      strength: decayedStrength(cl.touches * 2, cl.maxIndex, lastIdx, o.decayPerBar),
      touches: cl.touches,
      timeframe: timeframeLabel,
      status: 'active',
    });
  }
  for (const cl of lowClusters) {
    pools.push({
      kind: 'sellside',
      price: cl.meanPrice,
      createdBarIndex: cl.maxIndex,
      strength: decayedStrength(cl.touches * 2, cl.maxIndex, lastIdx, o.decayPerBar),
      touches: cl.touches,
      timeframe: timeframeLabel,
      status: 'active',
    });
  }

  const w0 = n - o.fallbackWindowFromEnd;
  const w1 = n - o.fallbackWindowToEnd;
  const window = candles.slice(Math.max(0, w0), Math.max(0, w1));
  if (window.length > 0) {
    const rangeHigh = Math.max(...window.map((c) => c.high));
    const rangeLow = Math.min(...window.map((c) => c.low));
    const hiIdx = w0 + window.findIndex((c) => c.high === rangeHigh);
    const loIdx = w0 + window.findIndex((c) => c.low === rangeLow);
    pools.push({
      kind: 'buyside',
      price: rangeHigh,
      createdBarIndex: hiIdx,
      strength: decayedStrength(1, hiIdx, lastIdx, o.decayPerBar),
      touches: 1,
      timeframe: timeframeLabel,
      status: 'active',
    });
    pools.push({
      kind: 'sellside',
      price: rangeLow,
      createdBarIndex: loIdx,
      strength: decayedStrength(1, loIdx, lastIdx, o.decayPerBar),
      touches: 1,
      timeframe: timeframeLabel,
      status: 'active',
    });
  }

  const deduped: LiquidityPoolView[] = [];
  for (const p of pools) {
    const dup = deduped.find(
      (q) =>
        q.kind === p.kind &&
        Math.abs(q.price - p.price) / Math.max(p.price, q.price, 1e-12) <= o.equalClusterPct * 0.5,
    );
    if (dup) {
      dup.strength += p.strength;
      dup.touches += p.touches;
      dup.createdBarIndex = Math.max(dup.createdBarIndex, p.createdBarIndex);
    } else {
      deduped.push({ ...p });
    }
  }
  const poolList = deduped;

  const atrSeries = atr(candles, 14);
  const scanFrom = Math.max(0, n - 12);
  const events: LiquidityEventView[] = [];
  for (const p of poolList) {
    const ev = evaluatePoolSide({ candles, atrSeries, pool: p, opts: o, scanFrom });
    if (ev) events.push(ev);
  }

  let bestRej: LiquidityEventView | null = null;
  let bestAcc: LiquidityEventView | null = null;
  for (const e of events) {
    if (e.outcome === 'rejection' && (!bestRej || e.score > bestRej.score)) bestRej = e;
    if (e.outcome === 'acceptance' && (!bestAcc || e.score > bestAcc.score)) bestAcc = e;
  }

  let classification: LiquidityClassification = 'NONE';
  let liquiditySweep: 'LONG' | 'SHORT' | 'NONE' = 'NONE';
  let sweepQualityScore = 0;

  if (bestRej && (!bestAcc || bestRej.score >= bestAcc.score)) {
    classification = 'SWEEP_REJECTION';
    sweepQualityScore = bestRej.score;
    liquiditySweep = bestRej.poolKind === 'buyside' ? 'LONG' : 'SHORT';
  } else if (bestAcc && (!bestRej || bestAcc.score > bestRej.score)) {
    classification = 'BREAKOUT_ACCEPTANCE';
    sweepQualityScore = bestAcc.score;
    liquiditySweep = 'NONE';
  }

  return {
    pools: poolList.slice(-12),
    events: events.slice(-6),
    primaryRejection: bestRej,
    primaryAcceptance: bestAcc,
    classification,
    liquiditySweep,
    sweepQualityScore,
  };
}
