import type { RedisBridge } from './redis-bridge';
import type { SymbolRef, InstrumentMeta } from '@chart-studio/adapter-core';

/**
 * Federated symbol search: query every online provider in parallel, merge
 * the results. Each result keeps its `provider` so the UI can route to the
 * right adapter.
 */
export const federatedSearchSymbols = async (
  bridge: RedisBridge,
  query: string,
  limit = 20,
): Promise<SymbolRef[]> => {
  const providers = bridge.snapshotPresence().filter((p) => p.online);
  if (providers.length === 0) return [];

  const results = await Promise.all(
    providers.map((p) => bridge.discover<SymbolRef[]>(p.provider, 'search', { query, limit })),
  );

  const merged: SymbolRef[] = [];
  for (const list of results) {
    if (!Array.isArray(list)) continue;
    for (const item of list) merged.push(item);
  }

  // Sort: exact symbol match first, then prefix, then substring; stable per provider order.
  const q = query.trim().toUpperCase();
  merged.sort((a, b) => score(b.symbol, q) - score(a.symbol, q));
  return merged.slice(0, limit);
};

const score = (symbol: string, q: string): number => {
  if (!q) return 0;
  const s = symbol.toUpperCase();
  if (s === q) return 1000;
  if (s.startsWith(q)) return 500;
  if (s.includes(q)) return 100;
  return 0;
};

export const federatedListSymbols = async (
  bridge: RedisBridge,
  provider: string,
  filter?: { segment?: string },
): Promise<InstrumentMeta[]> => {
  const data = await bridge.discover<InstrumentMeta[]>(provider, 'list', { filter });
  return Array.isArray(data) ? data : [];
};
