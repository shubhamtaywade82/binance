import type { ModelProposal } from './types';

export interface PolicyDecision {
  ok: boolean;
  errors: string[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const validatePolicy = (p: ModelProposal): PolicyDecision => {
  const errors: string[] = [];

  if (p.changes.length > 10) errors.push('too_many_changes');

  for (const c of p.changes) {
    if (c.param === 'leverage' && (!isNum(c.proposed) || c.proposed < 2 || c.proposed > 15)) {
      errors.push(`leverage_out_of_bounds:${c.scope}`);
    }
    if (c.param === 'minConfidence' && (!isNum(c.proposed) || c.proposed < 0.5 || c.proposed > 0.9)) {
      errors.push(`minConfidence_out_of_bounds:${c.scope}`);
    }
    if (c.param === 'minSmcScore' && (!isNum(c.proposed) || c.proposed < 1 || c.proposed > 5)) {
      errors.push(`minSmcScore_out_of_bounds:${c.scope}`);
    }
    if (c.param === 'tpPct' && (!isNum(c.proposed) || c.proposed < 0.003 || c.proposed > 0.04)) {
      errors.push(`tpPct_out_of_bounds:${c.scope}`);
    }
    if (c.param === 'slPct' && (!isNum(c.proposed) || c.proposed < 0.002 || c.proposed > 0.03)) {
      errors.push(`slPct_out_of_bounds:${c.scope}`);
    }
    if (c.param === 'marginUsdt' && isNum(c.old) && isNum(c.proposed) && c.old > 0) {
      const delta = Math.abs(c.proposed - c.old) / c.old;
      if (delta > 0.2) errors.push(`marginUsdt_delta_too_large:${c.scope}`);
    }
  }

  if (p.risk.drawdown_risk === 'high' && p.expected_impact.max_dd_delta_pct > 0) {
    errors.push('high_drawdown_risk_with_worse_dd');
  }

  return { ok: errors.length === 0, errors };
};
