import { describe, expect, it } from 'vitest';
import {
  correlationGuardConflict,
  findCorrelationCluster,
  openSidesBySymbol,
  parseCorrelationSymbolGroups,
  type PositionRiskLike,
} from '../src/strategy/correlation-guard';

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
