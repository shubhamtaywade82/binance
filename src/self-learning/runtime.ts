import type { DomainEvent } from '@coindcx/contracts';
import type { EventBus } from '../core/events/event-bus';
import type Redis from 'ioredis';
import { ProposalEngine } from './proposal-engine';
import { validatePolicy } from './policy-validator';
import { createSelfLearningPool } from './db';
import { publishTierOverrides } from './config-publisher';
import { modelProposalSchema, type ModelProposal } from './types';

interface RuntimeCfg {
  enabled: boolean;
  paperOnly: boolean;
  executionMode: 'paper' | 'live';
  intervalMs: number;
  ollamaUrl: string;
  ollamaModel: string;
}

export class SelfLearningRuntime {
  private timer: NodeJS.Timeout | null = null;
  private readonly latestSignalBySymbol = new Map<string, DomainEvent<any>>();

  constructor(
    private readonly cfg: RuntimeCfg,
    private readonly eventBus: EventBus,
    private readonly redis: Redis | null,
    private readonly log: { info: (m: string, meta?: any) => void; warn: (m: string, meta?: any) => void },
  ) {}

  async start(): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cfg.paperOnly && this.cfg.executionMode !== 'paper') {
      this.log.warn('self_learning_disabled_live_mode', { reason: 'paper_only_gate' });
      return;
    }
    await this.ensureSchema();
    this.hookFeatures();
    this.timer = setInterval(() => void this.runSelfLearningCycle(), this.cfg.intervalMs);
    this.log.info('self_learning_started', { intervalMs: this.cfg.intervalMs, model: this.cfg.ollamaModel });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private hookFeatures(): void {
    this.eventBus.subscribe('strategy.signal', (e: DomainEvent<any>) => {
      if (!e.symbol) return;
      this.latestSignalBySymbol.set(e.symbol, e);
      void this.insertTradeFeatureFromSignal(e);
    });

    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
      void this.updateFeatureOutcome(e);
    });
  }

  async runSelfLearningCycle(): Promise<void> {
    const pool = createSelfLearningPool();
    try {
      const metrics = await this.collectMetrics(pool);
      if (!metrics.length) return;

      const proposalEngine = new ProposalEngine(this.cfg.ollamaUrl, this.cfg.ollamaModel);
      const prompt = `METRICS_JSON=${JSON.stringify(metrics.slice(0, 20))}`;
      const proposal = await proposalEngine.generate(prompt, 'Return strict JSON only');
      modelProposalSchema.parse(proposal);

      const decision = validatePolicy(proposal);
      const status = decision.ok ? 'approved' : 'rejected_policy';
      const proposalRowId = await this.insertProposal(pool, proposal, decision.ok, decision.errors, status);

      if (!decision.ok) return;
      const overrides = this.toOverrides(proposal);
      await this.insertConfigVersion(pool, proposalRowId, overrides);
      await publishTierOverrides(this.redis, overrides);
      this.log.info('self_learning_applied', { proposalId: proposal.proposal_id, changes: proposal.changes.length });
    } catch (err) {
      this.log.warn('self_learning_cycle_failed', { err: (err as Error).message });
    } finally {
      await pool.end();
    }
  }

  private async ensureSchema(): Promise<void> {
    const pool = createSelfLearningPool();
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS trade_features (id BIGSERIAL PRIMARY KEY, decision_id TEXT UNIQUE NOT NULL, symbol TEXT NOT NULL, signal TEXT NOT NULL, confidence NUMERIC(8,6), regime TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), outcome_ready BOOLEAN NOT NULL DEFAULT false, pnl_usdt NUMERIC(18,8));`);
      await pool.query(`CREATE TABLE IF NOT EXISTS model_proposals (id BIGSERIAL PRIMARY KEY, proposal_id TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), raw_response JSONB NOT NULL, validator_ok BOOLEAN NOT NULL DEFAULT false, status TEXT NOT NULL, validator_errors JSONB NOT NULL DEFAULT '[]'::jsonb);`);
      await pool.query(`CREATE TABLE IF NOT EXISTS config_versions (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), config_version TEXT UNIQUE NOT NULL, source TEXT NOT NULL, model_proposal_id BIGINT REFERENCES model_proposals(id), config_patch JSONB NOT NULL, is_active BOOLEAN NOT NULL DEFAULT true);`);
    } finally { await pool.end(); }
  }

  private async collectMetrics(pool: ReturnType<typeof createSelfLearningPool>): Promise<any[]> {
    const res = await pool.query(`SELECT symbol, COUNT(*)::int AS n, AVG(COALESCE(pnl_usdt,0))::float8 AS avg_pnl FROM trade_features GROUP BY symbol ORDER BY n DESC`);
    return res.rows;
  }

  private async insertTradeFeatureFromSignal(e: DomainEvent<any>): Promise<void> {
    const pool = createSelfLearningPool();
    try {
      const decisionId = `${e.symbol}-${e.ts}`;
      await pool.query(`INSERT INTO trade_features (decision_id, symbol, signal, confidence, regime) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (decision_id) DO NOTHING`,
        [decisionId, e.symbol, e.payload?.signal ?? 'FLAT', Number(e.payload?.confidence ?? 0), e.payload?.metadata?.regime ?? null]);
    } finally { await pool.end(); }
  }

  private async updateFeatureOutcome(e: DomainEvent<any>): Promise<void> {
    const symbol = e.symbol ?? e.payload?.symbol;
    if (!symbol) return;
    const signal = this.latestSignalBySymbol.get(symbol);
    if (!signal) return;
    const decisionId = `${symbol}-${signal.ts}`;
    const pool = createSelfLearningPool();
    try {
      await pool.query(`UPDATE trade_features SET outcome_ready=true, pnl_usdt=$2 WHERE decision_id=$1`, [decisionId, Number(e.payload?.netUsdt ?? e.payload?.pnl ?? 0)]);
    } finally { await pool.end(); }
  }

  private async insertProposal(pool: ReturnType<typeof createSelfLearningPool>, proposal: ModelProposal, ok: boolean, errors: string[], status: string): Promise<number> {
    const r = await pool.query(`INSERT INTO model_proposals (proposal_id, raw_response, validator_ok, status, validator_errors) VALUES ($1,$2::jsonb,$3,$4,$5::jsonb) RETURNING id`,
      [proposal.proposal_id, JSON.stringify(proposal), ok, status, JSON.stringify(errors)]);
    return Number(r.rows[0].id);
  }

  private async insertConfigVersion(pool: ReturnType<typeof createSelfLearningPool>, proposalId: number, overrides: unknown): Promise<void> {
    const version = `cfg_${Date.now()}`;
    await pool.query(`INSERT INTO config_versions (config_version, source, model_proposal_id, config_patch, is_active) VALUES ($1,'model_proposal',$2,$3::jsonb,true)`,
      [version, proposalId, JSON.stringify(overrides)]);
  }

  private toOverrides(proposal: ModelProposal): Record<string, any> {
    const out: Record<string, any> = {};
    for (const c of proposal.changes) {
      if (c.scope === 'global') continue;
      out[c.scope] ??= {};
      out[c.scope][c.param] = c.proposed;
    }
    return out;
  }
}
