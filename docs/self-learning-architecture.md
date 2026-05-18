# Self-learning architecture draft (Ollama + llama.cpp)

This draft defines a concrete database schema, a strict Ollama JSON-schema prompt contract, and a TypeScript service skeleton that integrates with this repository's existing Postgres/Redis/event architecture.

## 1) Concrete DB schema

> Design goals:
> - Immutable audit trail of model recommendations and decisions.
> - Versioned runtime config snapshots with rollback support.
> - Experiment tracking for champion/challenger evaluation.
> - Feature/outcome records for supervised evaluation and drift checks.

### 1.1 `trade_features`

One row per decision point (usually per closed LTF bar per symbol), with optional linkage to eventual trade outcome.

```sql
CREATE TABLE IF NOT EXISTS trade_features (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- identifiers
  decision_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  timeframe_ltf TEXT NOT NULL,
  timeframe_htf TEXT NOT NULL,
  bar_open_ms BIGINT NOT NULL,
  bar_close_ms BIGINT NOT NULL,

  -- strategy context
  signal TEXT NOT NULL CHECK (signal IN ('LONG','SHORT','FLAT')),
  confidence NUMERIC(8,6) NOT NULL,
  smc_score NUMERIC(8,6),
  regime TEXT,

  -- indicator feature block (extend as needed)
  ema_fast NUMERIC(18,8),
  ema_slow NUMERIC(18,8),
  macd_hist NUMERIC(18,8),
  rsi NUMERIC(10,6),
  atr NUMERIC(18,8),
  vol_20_avg NUMERIC(18,8),
  vol_curr NUMERIC(18,8),

  -- market microstructure snapshot
  spread_bps NUMERIC(12,6),
  depth_imbalance NUMERIC(12,6),
  mark_price NUMERIC(18,8),
  funding_rate NUMERIC(12,8),

  -- policy/config references used at decision time
  config_version_id BIGINT,
  model_proposal_id BIGINT,
  experiment_arm TEXT, -- champion | challenger | baseline

  -- eventual outcome labels (nullable until trade closes)
  trade_opened BOOLEAN NOT NULL DEFAULT false,
  trade_id TEXT,
  outcome_ready BOOLEAN NOT NULL DEFAULT false,
  pnl_usdt NUMERIC(18,8),
  pnl_r NUMERIC(18,8),
  mae_pct NUMERIC(12,6),
  mfe_pct NUMERIC(12,6),
  hold_seconds INTEGER,
  win BOOLEAN,

  -- metadata
  source_event_id TEXT,
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_trade_features_symbol_time
  ON trade_features (symbol, bar_close_ms DESC);
CREATE INDEX IF NOT EXISTS idx_trade_features_regime
  ON trade_features (regime);
CREATE INDEX IF NOT EXISTS idx_trade_features_outcome_ready
  ON trade_features (outcome_ready, symbol, bar_close_ms DESC);
```

### 1.2 `model_proposals`

Stores every LLM proposal payload plus validator decisions.

```sql
CREATE TABLE IF NOT EXISTS model_proposals (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  proposal_id TEXT NOT NULL UNIQUE,
  model_name TEXT NOT NULL,              -- e.g. llama3.1:8b-instruct-q8
  model_provider TEXT NOT NULL DEFAULT 'ollama',
  model_digest TEXT,                     -- optional model hash/tag

  window_start_ms BIGINT NOT NULL,
  window_end_ms BIGINT NOT NULL,

  objective TEXT NOT NULL,               -- short objective text
  prompt_version TEXT NOT NULL,

  input_summary JSONB NOT NULL,          -- compact metrics sent to model
  raw_response JSONB NOT NULL,           -- exact JSON from model

  parsed_ok BOOLEAN NOT NULL DEFAULT false,
  schema_ok BOOLEAN NOT NULL DEFAULT false,
  validator_ok BOOLEAN NOT NULL DEFAULT false,

  validator_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,

  status TEXT NOT NULL CHECK (
    status IN ('proposed','rejected_schema','rejected_policy','approved','superseded','rolled_back')
  ),

  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_proposals_window
  ON model_proposals (window_end_ms DESC);
CREATE INDEX IF NOT EXISTS idx_model_proposals_status
  ON model_proposals (status, created_at DESC);
```

### 1.3 `config_versions`

Versioned effective runtime configuration snapshots; references proposal (if any).

```sql
CREATE TABLE IF NOT EXISTS config_versions (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  config_version TEXT NOT NULL UNIQUE,   -- e.g. cfg_2026_05_18_0001
  parent_version TEXT,
  source TEXT NOT NULL CHECK (source IN ('manual','model_proposal','rollback')),
  model_proposal_id BIGINT REFERENCES model_proposals(id),

  is_active BOOLEAN NOT NULL DEFAULT false,
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,

  config_json JSONB NOT NULL,            -- full merged config snapshot
  config_patch JSONB NOT NULL DEFAULT '{}'::jsonb,

  checksum TEXT NOT NULL,
  comment TEXT
);

CREATE INDEX IF NOT EXISTS idx_config_versions_active
  ON config_versions (is_active, created_at DESC);
```

### 1.4 `experiment_results`

Tracks champion/challenger experiments by symbol/regime/window.

```sql
CREATE TABLE IF NOT EXISTS experiment_results (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  experiment_id TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  regime TEXT,

  start_ms BIGINT NOT NULL,
  end_ms BIGINT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','aborted')),

  champion_config_version TEXT NOT NULL,
  challenger_config_version TEXT NOT NULL,

  allocation_ratio NUMERIC(6,4) NOT NULL DEFAULT 0.1000,
  min_samples INTEGER NOT NULL DEFAULT 100,

  champion_trades INTEGER NOT NULL DEFAULT 0,
  challenger_trades INTEGER NOT NULL DEFAULT 0,

  champion_expectancy NUMERIC(18,8),
  challenger_expectancy NUMERIC(18,8),
  champion_win_rate NUMERIC(10,6),
  challenger_win_rate NUMERIC(10,6),
  champion_max_dd_pct NUMERIC(12,6),
  challenger_max_dd_pct NUMERIC(12,6),

  decision TEXT CHECK (decision IN ('promote_challenger','keep_champion','inconclusive','abort_risk')),
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,

  stats_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_experiment_results_status
  ON experiment_results (status, created_at DESC);
```

## 2) Exact JSON schema prompt for Ollama

Use Ollama structured output mode (or strict post-parse validation) with the following schema.

### 2.1 JSON Schema (`model-proposal.schema.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://coindcx/binance-hybrid/schemas/model-proposal.schema.json",
  "title": "ModelProposal",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "proposal_id",
    "window",
    "summary",
    "changes",
    "risk",
    "expected_impact",
    "confidence"
  ],
  "properties": {
    "proposal_id": { "type": "string", "minLength": 8, "maxLength": 64 },
    "window": {
      "type": "object",
      "additionalProperties": false,
      "required": ["start_ms", "end_ms"],
      "properties": {
        "start_ms": { "type": "integer", "minimum": 0 },
        "end_ms": { "type": "integer", "minimum": 0 }
      }
    },
    "summary": { "type": "string", "minLength": 10, "maxLength": 1000 },
    "changes": {
      "type": "array",
      "minItems": 1,
      "maxItems": 50,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["scope", "param", "old", "proposed", "reason"],
        "properties": {
          "scope": { "type": "string", "pattern": "^(global|[A-Z0-9]{3,20}USDT)$" },
          "param": {
            "type": "string",
            "enum": [
              "minConfidence",
              "minSmcScore",
              "tpPct",
              "slPct",
              "marginUsdt",
              "leverage",
              "tier",
              "ltf",
              "htf"
            ]
          },
          "old": { "type": ["number", "string", "null"] },
          "proposed": { "type": ["number", "string"] },
          "reason": { "type": "string", "minLength": 5, "maxLength": 400 }
        }
      }
    },
    "risk": {
      "type": "object",
      "additionalProperties": false,
      "required": ["drawdown_risk", "overfit_risk", "liquidity_risk"],
      "properties": {
        "drawdown_risk": { "type": "string", "enum": ["low", "medium", "high"] },
        "overfit_risk": { "type": "string", "enum": ["low", "medium", "high"] },
        "liquidity_risk": { "type": "string", "enum": ["low", "medium", "high"] },
        "notes": { "type": "string", "maxLength": 500 }
      }
    },
    "expected_impact": {
      "type": "object",
      "additionalProperties": false,
      "required": ["expectancy_delta_bps", "win_rate_delta_pct", "max_dd_delta_pct"],
      "properties": {
        "expectancy_delta_bps": { "type": "number", "minimum": -500, "maximum": 500 },
        "win_rate_delta_pct": { "type": "number", "minimum": -30, "maximum": 30 },
        "max_dd_delta_pct": { "type": "number", "minimum": -30, "maximum": 30 }
      }
    },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  }
}
```

### 2.2 System prompt (exact)

```text
You are a trading-parameter optimization assistant.
Return ONLY strict JSON matching the provided JSON Schema.
Do not include markdown, comments, or extra keys.
Propose bounded, risk-aware parameter changes only.
Never propose disabling risk controls.
If evidence is weak, propose smaller changes and state uncertainty in summary/risk.notes.
```

### 2.3 User prompt template (exact)

```text
OBJECTIVE:
Improve risk-adjusted expectancy while constraining drawdown.

HARD CONSTRAINTS:
- minConfidence must remain in [0.50, 0.90]
- minSmcScore must remain in [1.0, 5.0]
- leverage must remain in [2, 15]
- tpPct must remain in [0.003, 0.040]
- slPct must remain in [0.002, 0.030]
- marginUsdt change per update <= 20%
- max 10 parameter changes per proposal

DATA WINDOW:
{{window_json}}

CURRENT CONFIG SNAPSHOT:
{{config_json}}

PERFORMANCE SUMMARY BY SYMBOL/REGIME:
{{metrics_json}}

RECENT FAILURE MODES:
{{failure_modes_json}}

Return JSON only.
```

## 3) TypeScript service skeleton

Suggested module layout:

```text
src/self-learning/
  index.ts
  types.ts
  db.ts
  feature-writer.ts
  proposal-engine.ts
  policy-validator.ts
  config-publisher.ts
  experiment-runner.ts
  scheduler.ts
```

### 3.1 `types.ts`

```ts
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ProposalChange {
  scope: string;
  param: 'minConfidence' | 'minSmcScore' | 'tpPct' | 'slPct' | 'marginUsdt' | 'leverage' | 'tier' | 'ltf' | 'htf';
  old: number | string | null;
  proposed: number | string;
  reason: string;
}

export interface ModelProposal {
  proposal_id: string;
  window: { start_ms: number; end_ms: number };
  summary: string;
  changes: ProposalChange[];
  risk: {
    drawdown_risk: RiskLevel;
    overfit_risk: RiskLevel;
    liquidity_risk: RiskLevel;
    notes?: string;
  };
  expected_impact: {
    expectancy_delta_bps: number;
    win_rate_delta_pct: number;
    max_dd_delta_pct: number;
  };
  confidence: number;
}
```

### 3.2 `db.ts`

```ts
import { Pool } from 'pg';

export const createPool = (): Pool => {
  return new Pool({
    connectionString: process.env.PG_URL,
    max: Number(process.env.SL_PG_MAX ?? 10),
  });
};
```

### 3.3 `proposal-engine.ts`

```ts
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { ModelProposal } from './types';

const schema = /* load model-proposal.schema.json */ {};

export class ProposalEngine {
  private validate: ReturnType<Ajv['compile']>;

  constructor(private readonly ollamaUrl: string, private readonly model: string) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    this.validate = ajv.compile(schema);
  }

  async generate(userPrompt: string, systemPrompt: string): Promise<ModelProposal> {
    const r = await fetch(`${this.ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: `${systemPrompt}\n\n${userPrompt}`,
        stream: false,
        format: 'json',
      }),
    });
    if (!r.ok) throw new Error(`ollama_http_${r.status}`);

    const payload = await r.json() as { response: string };
    const parsed = JSON.parse(payload.response);

    const ok = this.validate(parsed);
    if (!ok) throw new Error(`proposal_schema_invalid: ${JSON.stringify(this.validate.errors)}`);

    return parsed as ModelProposal;
  }
}
```

### 3.4 `policy-validator.ts`

```ts
import type { ModelProposal } from './types';

export interface PolicyDecision {
  ok: boolean;
  errors: string[];
}

export const validatePolicy = (p: ModelProposal): PolicyDecision => {
  const errors: string[] = [];

  if (p.changes.length > 10) errors.push('too_many_changes');

  for (const c of p.changes) {
    if (c.param === 'leverage' && (Number(c.proposed) < 2 || Number(c.proposed) > 15)) {
      errors.push(`leverage_out_of_bounds:${c.scope}`);
    }
    if (c.param === 'minConfidence' && (Number(c.proposed) < 0.5 || Number(c.proposed) > 0.9)) {
      errors.push(`minConfidence_out_of_bounds:${c.scope}`);
    }
  }

  if (p.risk.drawdown_risk === 'high' && p.expected_impact.max_dd_delta_pct > 0) {
    errors.push('high_drawdown_risk_with_worse_dd');
  }

  return { ok: errors.length === 0, errors };
};
```

### 3.5 `config-publisher.ts`

```ts
import type Redis from 'ioredis';

export const publishTierOverrides = async (redis: Redis, overrides: unknown): Promise<void> => {
  await redis.set('selflearn:asset_tier_overrides_json', JSON.stringify(overrides));
  await redis.publish('selflearn:config:changed', JSON.stringify({ ts: Date.now(), overrides }));
};
```

### 3.6 `index.ts` (orchestrator skeleton)

```ts
import Redis from 'ioredis';
import { createPool } from './db';
import { ProposalEngine } from './proposal-engine';
import { validatePolicy } from './policy-validator';
import { publishTierOverrides } from './config-publisher';

export const runSelfLearningCycle = async (): Promise<void> => {
  const pg = createPool();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

  // 1) read latest metrics/features
  // 2) build prompt
  // 3) call ollama
  // 4) schema + policy validate
  // 5) persist model_proposals row
  // 6) if approved: persist config_versions + publish runtime update

  const engine = new ProposalEngine(
    process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
    process.env.OLLAMA_MODEL ?? 'llama3.1:8b-instruct-q8_0',
  );

  const proposal = await engine.generate('...user prompt...', '...system prompt...');
  const decision = validatePolicy(proposal);

  if (!decision.ok) {
    // mark proposal rejected_policy
    return;
  }

  // build bounded override payload from allowed params only
  const overrides = {};
  await publishTierOverrides(redis, overrides);

  await pg.end();
  await redis.quit();
};
```

## 4) Integration points in current repo

- Feature ingestion trigger: subscribe to `strategy.signal`, `execution.order.filled`, `execution.position.closed` from the event bus stream already persisted by the event-store path.
- Postgres writing path: mirror patterns used in `PgWriter` for resilient inserts/batch behavior.
- Runtime config propagation: use Redis pub/sub style similar to existing runtime config updates.
- Alerts: optionally emit AI proposal lifecycle notifications (`proposed`, `approved`, `rejected`) via existing notifier categories.

## 5) Rollout checklist

1. Run only in paper mode initially.
2. Enforce hard policy bounds before every apply.
3. Enable champion/challenger experiments before automatic promotion.
4. Add rollback-on-drawdown trigger tied to `config_versions` parent chain.
5. Keep human approval required until statistically stable.
