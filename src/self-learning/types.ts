import { z } from 'zod';

export const riskLevelSchema = z.enum(['low', 'medium', 'high']);

export const proposalChangeSchema = z.object({
  scope: z.string().regex(/^(global|[A-Z0-9]{3,20}USDT)$/),
  param: z.enum(['minConfidence', 'minSmcScore', 'tpPct', 'slPct', 'marginUsdt', 'leverage', 'tier', 'ltf', 'htf']),
  old: z.union([z.number(), z.string(), z.null()]),
  proposed: z.union([z.number(), z.string()]),
  reason: z.string().min(5).max(400),
}).strict();

export const modelProposalSchema = z.object({
  proposal_id: z.string().min(8).max(64),
  window: z.object({
    start_ms: z.number().int().nonnegative(),
    end_ms: z.number().int().nonnegative(),
  }).strict(),
  summary: z.string().min(10).max(1000),
  changes: z.array(proposalChangeSchema).min(1).max(50),
  risk: z.object({
    drawdown_risk: riskLevelSchema,
    overfit_risk: riskLevelSchema,
    liquidity_risk: riskLevelSchema,
    notes: z.string().max(500).optional(),
  }).strict(),
  expected_impact: z.object({
    expectancy_delta_bps: z.number().min(-500).max(500),
    win_rate_delta_pct: z.number().min(-30).max(30),
    max_dd_delta_pct: z.number().min(-30).max(30),
  }).strict(),
  confidence: z.number().min(0).max(1),
}).strict();

export type ModelProposal = z.infer<typeof modelProposalSchema>;
