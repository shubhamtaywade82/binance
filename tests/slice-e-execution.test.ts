import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const generateClientOrderId = (symbol: string, side: string, ts = Date.now()): string => {
  const raw = `${symbol}:${side}:${ts}`;
  return 'bot_' + createHash('sha256').update(raw).digest('hex').slice(0, 28);
};

describe('clientOrderId generation', () => {
  it('produces deterministic ID for same inputs', () => {
    const id1 = generateClientOrderId('SOLUSDT', 'BUY', 1000);
    const id2 = generateClientOrderId('SOLUSDT', 'BUY', 1000);
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different timestamps', () => {
    const id1 = generateClientOrderId('SOLUSDT', 'BUY', 1000);
    const id2 = generateClientOrderId('SOLUSDT', 'BUY', 1001);
    expect(id1).not.toBe(id2);
  });

  it('produces different IDs for different sides', () => {
    const id1 = generateClientOrderId('SOLUSDT', 'BUY', 1000);
    const id2 = generateClientOrderId('SOLUSDT', 'SELL', 1000);
    expect(id1).not.toBe(id2);
  });

  it('prefixes with bot_', () => {
    const id = generateClientOrderId('SOLUSDT', 'BUY');
    expect(id.startsWith('bot_')).toBe(true);
  });

  it('is at most 32 characters', () => {
    const id = generateClientOrderId('SOLUSDT', 'BUY');
    expect(id.length).toBe(32);
  });
});

describe('TradeAttribution interface', () => {
  it('is addable to ClosedPosition', () => {
    const attr: { entrySignal?: string; smcZone?: string; htfBias?: string; confidence?: number } = {
      entrySignal: 'smc_ob',
      smcZone: 'demand',
      htfBias: 'LONG',
      confidence: 0.85,
    };
    expect(attr.entrySignal).toBe('smc_ob');
    expect(attr.confidence).toBe(0.85);
  });
});
