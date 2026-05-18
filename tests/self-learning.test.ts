import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { modelProposalSchema, type ModelProposal } from '../src/self-learning/types';
import { validatePolicy } from '../src/self-learning/policy-validator';
import { ProposalEngine } from '../src/self-learning/proposal-engine';
import { publishTierOverrides, SELFLEARN_CHANGE_CHANNEL, SELFLEARN_OVERRIDES_KEY } from '../src/self-learning/config-publisher';

const baseProposal: ModelProposal = {
  proposal_id: 'proposal_1234',
  window: { start_ms: 1, end_ms: 2 },
  summary: 'Increase confidence for noisy sessions.',
  changes: [{ scope: 'BTCUSDT', param: 'minConfidence', old: 0.65, proposed: 0.68, reason: 'Reduce false positives' }],
  risk: { drawdown_risk: 'low', overfit_risk: 'medium', liquidity_risk: 'low' },
  expected_impact: { expectancy_delta_bps: 8, win_rate_delta_pct: 1.1, max_dd_delta_pct: -0.8 },
  confidence: 0.73,
};

describe('self-learning schemas and policy', () => {
  it('accepts valid proposal schema', () => {
    expect(modelProposalSchema.parse(baseProposal)).toEqual(baseProposal);
  });

  it('rejects invalid scope pattern', () => {
    const invalid = { ...baseProposal, changes: [{ ...baseProposal.changes[0], scope: 'btc' }] };
    expect(() => modelProposalSchema.parse(invalid)).toThrow();
  });

  it('rejects policy when margin delta exceeds 20%', () => {
    const p: ModelProposal = {
      ...baseProposal,
      changes: [{ scope: 'ETHUSDT', param: 'marginUsdt', old: 1000, proposed: 1300, reason: 'Too aggressive sizing change' }],
    };
    const d = validatePolicy(p);
    expect(d.ok).toBe(false);
    expect(d.errors).toContain('marginUsdt_delta_too_large:ETHUSDT');
  });

  it('accepts bounded policy changes', () => {
    const p: ModelProposal = {
      ...baseProposal,
      changes: [{ scope: 'global', param: 'leverage', old: 10, proposed: 9, reason: 'Lower volatility risk' }],
    };
    expect(validatePolicy(p)).toEqual({ ok: true, errors: [] });
  });
});

describe('ProposalEngine', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('posts to ollama and parses strict JSON response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: JSON.stringify(baseProposal) }),
    });
    // @ts-expect-error test mock
    global.fetch = fetchMock;

    const engine = new ProposalEngine('http://127.0.0.1:11434', 'llama3.1');
    const out = await engine.generate('user', 'system');
    expect(out.proposal_id).toBe('proposal_1234');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws on HTTP failures', async () => {
    // @ts-expect-error test mock
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    const engine = new ProposalEngine('http://127.0.0.1:11434', 'llama3.1');
    await expect(engine.generate('u', 's')).rejects.toThrow('ollama_http_503');
  });
});

describe('publishTierOverrides', () => {
  it('writes redis key and publishes channel', async () => {
    const redis = {
      set: vi.fn().mockResolvedValue('OK'),
      publish: vi.fn().mockResolvedValue(1),
    } as any;

    const overrides = { BTCUSDT: { minConfidence: 0.7 } };
    await publishTierOverrides(redis, overrides);

    expect(redis.set).toHaveBeenCalledWith(SELFLEARN_OVERRIDES_KEY, JSON.stringify(overrides));
    expect(redis.publish).toHaveBeenCalledOnce();
    expect(redis.publish.mock.calls[0][0]).toBe(SELFLEARN_CHANGE_CHANNEL);
  });

  it('is no-op when redis is null', async () => {
    await expect(publishTierOverrides(null, { a: 1 })).resolves.toBeUndefined();
  });
});
