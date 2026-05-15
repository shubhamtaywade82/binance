import type { Side } from '../types';

/** One row from Binance `GET /fapi/v2/positionRisk` (subset used here). */
export interface PositionRiskLike {
  symbol: string;
  positionAmt: string;
  positionSide: string;
}

/**
 * Parse `BINANCE_CORRELATION_SYMBOL_GROUPS`: pipe-separated clusters, comma-separated symbols.
 * Example: `BTCUSDT,ETHUSDT|SOLUSDT,AVAXUSDT`
 */
export const parseCorrelationSymbolGroups = (raw: string): string[][] => {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  return trimmed
    .split('|')
    .map((g) => g.split(',').map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))
    .filter((g) => g.length > 0);
};

export const findCorrelationCluster = (groups: string[][], symbolUpper: string): string[] | null => {
  const sym = symbolUpper.toUpperCase();
  for (const g of groups) {
    if (g.includes(sym)) return g;
  }
  return null;
};

const sideFromRow = (row: PositionRiskLike): Side | null => {
  const amt = Number(row.positionAmt);
  if (!Number.isFinite(amt) || Math.abs(amt) < 1e-12) return null;
  const ps = (row.positionSide ?? 'BOTH').toUpperCase();
  if (ps === 'LONG') return 'LONG';
  if (ps === 'SHORT') return 'SHORT';
  if (ps === 'BOTH' || ps === '') return amt > 0 ? 'LONG' : 'SHORT';
  return null;
};

/** Maps symbol → sides that currently have non-zero exposure on the exchange. */
export const openSidesBySymbol = (rows: PositionRiskLike[]): Map<string, Set<Side>> => {
  const map = new Map<string, Set<Side>>();
  for (const row of rows) {
    const side = sideFromRow(row);
    if (!side) continue;
    const sym = row.symbol.toUpperCase();
    if (!map.has(sym)) map.set(sym, new Set());
    map.get(sym)!.add(side);
  }
  return map;
};

export const correlationGuardConflict = (params: {
  cluster: string[];
  primarySymbol: string;
  intendedSide: Side;
  rows: PositionRiskLike[];
}): { blocked: boolean; conflictSymbol?: string } => {
  const { cluster, primarySymbol, intendedSide, rows } = params;
  const primary = primarySymbol.toUpperCase();
  const open = openSidesBySymbol(rows);
  for (const sym of cluster) {
    if (sym === primary) continue;
    if (open.get(sym)?.has(intendedSide)) {
      return { blocked: true, conflictSymbol: sym };
    }
  }
  return { blocked: false };
};
