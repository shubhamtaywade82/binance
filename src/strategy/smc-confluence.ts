import type { Candle, TrendBias } from '../types';
import { ema } from './indicators';
import { analyzeSmc } from './smc';

export type ConfluenceMode = 'standard' | 'sniper';

export interface SmcConfluenceConfig {
  enabled: boolean;
  mode: ConfluenceMode;
  standardMinScore: number;
  sniperMinScore: number;
  targetPct: number;
}

export interface SmcConfluenceResult {
  pass: boolean;
  direction: TrendBias;
  score: number;
  threshold: number;
  reasons: string[];
}

function emaTrend(c: Candle[]): TrendBias {
  if (c.length < 30) return 'NONE';
  const closes = c.map((x) => x.close);
  const c9 = ema(closes, 9);
  const c21 = ema(closes, 21);
  const i = c.length - 1;
  if (!Number.isFinite(c9[i]) || !Number.isFinite(c21[i])) return 'NONE';
  if (c9[i] > c21[i]) return 'LONG';
  if (c9[i] < c21[i]) return 'SHORT';
  return 'NONE';
}

export function evaluateSmcConfluence(
  ltfCandles: Candle[],
  htfCandles: Candle[],
  marketBias: TrendBias,
  refPrice: number,
  cfg: SmcConfluenceConfig,
): SmcConfluenceResult {
  const reasons: string[] = [];
  const threshold = cfg.mode === 'sniper' ? cfg.sniperMinScore : cfg.standardMinScore;
  if (!cfg.enabled) {
    return { pass: true, direction: marketBias, score: threshold, threshold, reasons: ['disabled'] };
  }
  if (marketBias === 'NONE') {
    return { pass: false, direction: 'NONE', score: 0, threshold, reasons: ['no_market_bias'] };
  }

  const htfTrend = emaTrend(htfCandles);
  const htfSmc = analyzeSmc(htfCandles, refPrice, marketBias);
  const ltfSmc = analyzeSmc(ltfCandles, refPrice, marketBias);

  let score = 0;
  if (htfTrend === marketBias) {
    score += 1.5;
    reasons.push('ema_alignment');
  }
  if (htfSmc.bos !== 'NONE' && ((marketBias === 'LONG' && htfSmc.bos === 'BULLISH') || (marketBias === 'SHORT' && htfSmc.bos === 'BEARISH'))) {
    score += 1.5;
    reasons.push('htf_bos');
  }
  if (ltfSmc.orderBlock && ((marketBias === 'LONG' && ltfSmc.orderBlock.type === 'BULLISH') || (marketBias === 'SHORT' && ltfSmc.orderBlock.type === 'BEARISH'))) {
    score += 1;
    reasons.push('ltf_ob');
  }
  if (ltfSmc.liquiditySweep !== 'NONE') {
    const favorableSweep = (marketBias === 'LONG' && ltfSmc.liquiditySweep === 'SHORT')
      || (marketBias === 'SHORT' && ltfSmc.liquiditySweep === 'LONG');
    if (favorableSweep) {
      score += 1.5;
      reasons.push('liq_sweep');
    }
  }
  if (ltfSmc.choch !== 'NONE' && ((marketBias === 'LONG' && ltfSmc.choch === 'BULLISH') || (marketBias === 'SHORT' && ltfSmc.choch === 'BEARISH'))) {
    score += 1;
    reasons.push('choch');
  }

  const targetPx = marketBias === 'LONG' ? refPrice * (1 + cfg.targetPct) : refPrice * (1 - cfg.targetPct);
  if (!Number.isFinite(targetPx) || targetPx <= 0) reasons.push('invalid_target');

  return {
    pass: score >= threshold,
    direction: marketBias,
    score,
    threshold,
    reasons,
  };
}
