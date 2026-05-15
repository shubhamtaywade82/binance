import { describe, expect, it } from 'vitest';
import {
  correlationGuardConflict,
  findCorrelationCluster,
  openSidesBySymbol,
  parseCorrelationSymbolGroups,
  type PositionRiskLike,
} from '../src/strategy/correlation-guard';
import {
  CorrelationGuard,
  type CorrelationPair,
} from '../src/risk/correlation-guard';

describe('Cluster-based Correlation Guard (Strategy)', () => {
  describe('parseCorrelationSymbolGroups', () => {
    it('parses pipe-separated clusters with comma symbols', () => {
      expect(parseCorrelationSymbolGroups(' BTCUSDT, ethusdt | solusdt ')).toEqual([
        ['BTCUSDT', 'ETHUSDT'],
        ['SOLUSDT'],
      ]);
    });

    it('returns empty when blank', () => {
      expect(parseCorrelationSymbolGroups('')).toEqual([]);
      expect(parseCorrelationSymbolGroups('  ')).toEqual([]);
    });
  });

  describe('findCorrelationCluster', () => {
    const groups = parseCorrelationSymbolGroups('BTCUSDT,ETHUSDT|SOLUSDT');

    it('finds the cluster containing a symbol', () => {
      expect(findCorrelationCluster(groups, 'ETHUSDT')).toEqual(['BTCUSDT', 'ETHUSDT']);
      expect(findCorrelationCluster(groups, 'SOLUSDT')).toEqual(['SOLUSDT']);
    });

    it('returns null when symbol is in no cluster', () => {
      expect(findCorrelationCluster(groups, 'DOGEUSDT')).toBeNull();
    });
  });

  describe('openSidesBySymbol', () => {
    it('maps one-way positions by sign of positionAmt', () => {
      const rows: PositionRiskLike[] = [
        { symbol: 'BTCUSDT', positionAmt: '0.01', positionSide: 'BOTH' },
        { symbol: 'ETHUSDT', positionAmt: '-2', positionSide: 'BOTH' },
      ];
      const m = openSidesBySymbol(rows);
      expect(m.get('BTCUSDT')).toEqual(new Set(['LONG']));
      expect(m.get('ETHUSDT')).toEqual(new Set(['SHORT']));
    });

    it('maps hedge-mode LONG and SHORT legs', () => {
      const rows: PositionRiskLike[] = [
        { symbol: 'BTCUSDT', positionAmt: '0.1', positionSide: 'LONG' },
        { symbol: 'BTCUSDT', positionAmt: '0', positionSide: 'SHORT' },
      ];
      const m = openSidesBySymbol(rows);
      expect(m.get('BTCUSDT')).toEqual(new Set(['LONG']));
    });
  });

  describe('correlationGuardConflict', () => {
    const cluster = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    it('blocks when another cluster member has the same side', () => {
      const rows: PositionRiskLike[] = [{ symbol: 'ETHUSDT', positionAmt: '1', positionSide: 'BOTH' }];
      expect(
        correlationGuardConflict({
          cluster,
          primarySymbol: 'SOLUSDT',
          intendedSide: 'LONG',
          rows,
        }),
      ).toEqual({ blocked: true, conflictSymbol: 'ETHUSDT' });
    });

    it('allows opposite-direction exposure on another member', () => {
      const rows: PositionRiskLike[] = [{ symbol: 'ETHUSDT', positionAmt: '-1', positionSide: 'BOTH' }];
      expect(
        correlationGuardConflict({
          cluster,
          primarySymbol: 'SOLUSDT',
          intendedSide: 'LONG',
          rows,
        }).blocked,
      ).toBe(false);
    });

    it('ignores flat symbols', () => {
      const rows: PositionRiskLike[] = [{ symbol: 'ETHUSDT', positionAmt: '0', positionSide: 'BOTH' }];
      expect(
        correlationGuardConflict({
          cluster,
          primarySymbol: 'SOLUSDT',
          intendedSide: 'LONG',
          rows,
        }).blocked,
      ).toBe(false);
    });
  });
});

const pairs: CorrelationPair[] = [
  { symbolA: 'BTCUSDT', symbolB: 'ETHUSDT', correlation: 0.85 },
  { symbolA: 'BTCUSDT', symbolB: 'SOLUSDT', correlation: 0.6 },
  { symbolA: 'BTCUSDT', symbolB: 'XRPUSDT', correlation: -0.8 },
  { symbolA: 'ETHUSDT', symbolB: 'SOLUSDT', correlation: 0.72 },
];

describe('Matrix-based Correlation Guard (Risk)', () => {
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
