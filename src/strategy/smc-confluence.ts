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

export const emaTrend = (c: Candle[]): TrendBias => {
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

export const evaluateSmcConfluence = (ltfCandles: Candle[], htfCandles: Candle[], marketBias: TrendBias, refPrice: number, cfg: SmcConfluenceConfig): SmcConfluenceResult => {
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
  
  // 1. Trend Alignment
  if (htfTrend === marketBias) {
    score += 1.5;
    reasons.push('ema_alignment');
  }

  // 2. Market Structure (BOS / CHoCH)
  if (htfSmc.bos !== 'NONE' && ((marketBias === 'LONG' && htfSmc.bos === 'BULLISH') || (marketBias === 'SHORT' && htfSmc.bos === 'BEARISH'))) {
    score += 1.5;
    reasons.push('htf_bos');
  }
  if (ltfSmc.choch !== 'NONE' && ((marketBias === 'LONG' && ltfSmc.choch === 'BULLISH') || (marketBias === 'SHORT' && ltfSmc.choch === 'BEARISH'))) {
    score += 1;
    reasons.push('ltf_choch');
  }

  // 3. Blocks & Gaps
  const validObs = ltfSmc.orderBlocks.filter(ob => 
    !ob.isMitigated && 
    ((marketBias === 'LONG' && ob.type === 'BULLISH') || (marketBias === 'SHORT' && ob.type === 'BEARISH'))
  );

  const topOb = validObs.sort((a, b) => b.score - a.score)[0];
  if (topOb) {
    if (topOb.score >= 6) {
      score += 2.5; // Institutional-grade OB
      reasons.push('institutional_ob');
    } else if (topOb.score >= 4) {
      score += 1.5;
      reasons.push('high_quality_ob');
    } else {
      score += 0.5;
      reasons.push('minor_ob');
    }
  }

  const validFvgs = ltfSmc.fvgs.filter(fvg => 
    ((marketBias === 'LONG' && fvg.type === 'BULLISH') || (marketBias === 'SHORT' && fvg.type === 'BEARISH'))
  );
  if (validFvgs.length > 0) {
    const topFvg = validFvgs.sort((a, b) => b.score - a.score)[0];
    score += (topFvg?.score || 0.5);
    reasons.push('fvg_alignment');
  }

  if ((marketBias === 'LONG' && ltfSmc.breakers.some(bb => bb.type === 'BULLISH')) || 
      (marketBias === 'SHORT' && ltfSmc.breakers.some(bb => bb.type === 'BEARISH'))) {
    score += 1;
    reasons.push('breaker_flip');
  }

  // 4. Liquidity & Sessions
  if (ltfSmc.liquiditySweep !== 'NONE') {
    const favorableSweep = (marketBias === 'LONG' && ltfSmc.liquiditySweep === 'SHORT')
      || (marketBias === 'SHORT' && ltfSmc.liquiditySweep === 'LONG');
    if (favorableSweep) {
      score += 1.5;
      reasons.push('liq_sweep');
      
      // Bonus for Asia Session Sweep
      const asiaBlock = ltfSmc.blocks.find(b => b.type === 'SESSION' && b.subType === 'ASIA');
      if (asiaBlock) {
        // If we just swept Asia High/Low
        score += 1.0;
        reasons.push('asia_sweep_confluence');
      }
    }
  }

  // 5. Dealing Range (Premium / Discount) - CRITICAL SMC RULE
  if (ltfSmc.dealingRange) {
    const isDiscount = refPrice < ltfSmc.dealingRange.equilibrium;
    const isPremium = refPrice > ltfSmc.dealingRange.equilibrium;
    
    if (marketBias === 'LONG') {
      if (isDiscount) {
        score += 1.5;
        reasons.push('discount_pricing');
      } else if (isPremium) {
        score -= 2.0; // Heavy penalty for buying in premium
        reasons.push('premium_risk');
      }
    } else if (marketBias === 'SHORT') {
      if (isPremium) {
        score += 1.5;
        reasons.push('premium_pricing');
      } else if (isDiscount) {
        score -= 2.0; // Heavy penalty for selling in discount
        reasons.push('discount_risk');
      }
    }
  }

  return {
    pass: score >= threshold,
    direction: marketBias,
    score,
    threshold,
    reasons,
  };
}
