import { describe, expect, it, beforeEach } from 'vitest';
import {
  ASSET_TIERS,
  applyTierOverrides,
  resetTierRegistryForTests,
  tierFor,
} from '../src/config/asset-tiers';

beforeEach(() => {
  resetTierRegistryForTests();
});

describe('asset-tiers default registry', () => {
  it('exposes the seven default symbols across both tiers', () => {
    expect(Object.keys(ASSET_TIERS).sort()).toEqual(
      ['AVAXUSDT', 'BTCUSDT', 'ETHUSDT', 'LINKUSDT', 'SOLUSDT', 'SUIUSDT'].sort(),
    );
  });

  it('classifies BTC/ETH/SOL as scalp', () => {
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      const t = tierFor(sym);
      expect(t).not.toBeNull();
      expect(t?.tier).toBe('scalp');
      expect(t?.ltf).toBe('5m');
    }
  });

  it('classifies SUI/AVAX/LINK as swing', () => {
    for (const sym of ['SUIUSDT', 'AVAXUSDT', 'LINKUSDT']) {
      const t = tierFor(sym);
      expect(t?.tier).toBe('swing');
      expect(t?.ltf).toBe('15m');
      expect(t?.htf).toBe('4h');
    }
  });

  it('is case-insensitive on symbol lookup', () => {
    expect(tierFor('solusdt')?.symbol).toBe('SOLUSDT');
    expect(tierFor('sOlUsDt')?.symbol).toBe('SOLUSDT');
  });

  it('returns null for unknown symbols', () => {
    expect(tierFor('DOGEUSDT')).toBeNull();
    expect(tierFor('')).toBeNull();
  });
});

describe('applyTierOverrides', () => {
  it('is a no-op when given empty/invalid JSON', () => {
    const before = { ...tierFor('SOLUSDT')! };
    applyTierOverrides('');
    expect(tierFor('SOLUSDT')).toEqual(before);
    applyTierOverrides('not json');
    expect(tierFor('SOLUSDT')).toEqual(before);
    applyTierOverrides('[1,2,3]');
    expect(tierFor('SOLUSDT')).toEqual(before);
  });

  it('merges partial overrides into existing tiers', () => {
    applyTierOverrides(JSON.stringify({ SOLUSDT: { leverage: 3, marginUsdt: 500 } }));
    const t = tierFor('SOLUSDT')!;
    expect(t.leverage).toBe(3);
    expect(t.marginUsdt).toBe(500);
    // Untouched fields preserved.
    expect(t.tier).toBe('scalp');
    expect(t.ltf).toBe('5m');
  });

  it('adds net-new symbols only when the entry is complete', () => {
    applyTierOverrides(JSON.stringify({
      DOGEUSDT: {
        tier: 'swing', ltf: '15m', htf: '4h',
        leverage: 3, tpPct: 0.02, slPct: 0.01, marginUsdt: 600, minConfidence: 0.7,
      },
      INCOMPLETE: { leverage: 5 },
    }));
    expect(tierFor('DOGEUSDT')?.symbol).toBe('DOGEUSDT');
    expect(tierFor('DOGEUSDT')?.marginUsdt).toBe(600);
    expect(tierFor('INCOMPLETE')).toBeNull();
  });

  it('rejects invalid override field types', () => {
    const before = tierFor('SOLUSDT')!.leverage;
    applyTierOverrides(JSON.stringify({ SOLUSDT: { leverage: 'huge' } }));
    expect(tierFor('SOLUSDT')!.leverage).toBe(before);
  });
});
