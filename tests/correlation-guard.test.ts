import { describe, it, expect } from 'vitest';
import {
  CorrelationGuard,
  type CorrelationPair,
} from '../src/risk/correlation-guard';

const pairs: CorrelationPair[] = [
  { symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.85 },
  { symbolA: 'BTCUSDT', symbolB: 'SOLUSDT', correlation: 0.6 },
  { symbolA: 'BTCUSDT', symbolB: 'XRPUSDT', correlation: -0.8 },
  { symbolA: 'ETHUSDT', symbolB: 'SOLUSDT', correlation: 0.72 },
];

describe('CorrelationGuard', () => {
  describe('getCorrelation', () => {
    it('returns correlation for a known pair', () => {
      const guard = new CorrelationGuard(pairs);
      expect(guard.getCorrelation('BTCUSDT', 'ETHUSDT')).toBe(0.85);
    });

    it('returns correlation regardless of symbol order', () => {
      const guard = new CorrelationGuard(pairs);
      expect(guard.getCorrelation('ETHUSDT', 'BTCUSDT')).toBe(0.85);
    });

    it('returns null for an unknown pair', () => {
      const guard = new CorrelationGuard(pairs);
      expect(guard.getCorrelation('BTCUSDT', 'DOGEUSDT')).toBeNull();
    });
  });

  describe('wouldViolate — same-direction on positively correlated', () => {
    it('blocks same-direction LONG when correlation exceeds threshold', () => {
      const guard = new CorrelationGuard(pairs);
      const open = new Map([['BTCUSDT', 'LONG' as const]]);
      const result = guard.wouldViolate('ETHUSDT', 'LONG', open);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('highly correlated');
    });

    it('blocks same-direction SHORT when correlation exceeds threshold', () => {
      const guard = new CorrelationGuard(pairs);
      const open = new Map([['ETHUSDT', 'SHORT' as const]]);
      const result = guard.wouldViolate('BTCUSDT', 'SHORT', open);
      expect(result.blocked).toBe(true);
    });

    it('allows same-direction when correlation is below threshold', () => {
      const guard = new CorrelationGuard(pairs);
      const open = new Map([['BTCUSDT', 'LONG' as const]]);
      const result = guard.wouldViolate('SOLUSDT', 'LONG', open);
      expect(result.blocked).toBe(false);
    });
  });

  describe('wouldViolate — opposite-direction on negatively correlated', () => {
    it('blocks opposite-direction when correlation is highly negative', () => {
      const guard = new CorrelationGuard(pairs);
      const open = new Map([['BTCUSDT', 'LONG' as const]]);
      const result = guard.wouldViolate('XRPUSDT', 'SHORT', open);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('negatively correlated');
    });

    it('allows same-direction on negatively correlated pair (hedge)', () => {
      const guard = new CorrelationGuard(pairs);
      const open = new Map([['BTCUSDT', 'LONG' as const]]);
      const result = guard.wouldViolate('XRPUSDT', 'LONG', open);
      expect(result.blocked).toBe(false);
    });
  });

  describe('wouldViolate — no open positions', () => {
    it('returns blocked: false when no positions are open', () => {
      const guard = new CorrelationGuard(pairs);
      const result = guard.wouldViolate('BTCUSDT', 'LONG', new Map());
      expect(result.blocked).toBe(false);
    });
  });

  describe('wouldViolate — unknown symbol', () => {
    it('returns blocked: false for a symbol not in the matrix', () => {
      const guard = new CorrelationGuard(pairs);
      const open = new Map([['BTCUSDT', 'LONG' as const]]);
      const result = guard.wouldViolate('DOGEUSDT', 'LONG', open);
      expect(result.blocked).toBe(false);
    });
  });

  describe('custom threshold', () => {
    it('uses a stricter threshold', () => {
      const guard = new CorrelationGuard(pairs, { threshold: 0.5 });
      const open = new Map([['BTCUSDT', 'LONG' as const]]);
      const result = guard.wouldViolate('SOLUSDT', 'LONG', open);
      expect(result.blocked).toBe(true);
    });

    it('uses a relaxed threshold', () => {
      const guard = new CorrelationGuard(pairs, { threshold: 0.9 });
      const open = new Map([['BTCUSDT', 'LONG' as const]]);
      const result = guard.wouldViolate('ETHUSDT', 'LONG', open);
      expect(result.blocked).toBe(false);
    });
  });

  describe('updateCorrelations', () => {
    it('replaces old data with new data', () => {
      const guard = new CorrelationGuard(pairs);
      expect(guard.getCorrelation('BTCUSDT', 'ETHUSDT')).toBe(0.85);

      guard.updateCorrelations([
        { symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.4 },
      ]);

      expect(guard.getCorrelation('BTCUSDT', 'ETHUSDT')).toBe(0.4);
      expect(guard.getCorrelation('BTCUSDT', 'SOLUSDT')).toBeNull();
    });
  });

  describe('multiple open positions', () => {
    it('checks against all open positions and blocks on first violation', () => {
      const guard = new CorrelationGuard(pairs);
      const open = new Map<string, 'LONG' | 'SHORT'>([
        ['SOLUSDT', 'LONG'],
        ['BTCUSDT', 'LONG'],
      ]);
      const result = guard.wouldViolate('ETHUSDT', 'LONG', open);
      expect(result.blocked).toBe(true);
    });
  });
});
