/**
 * Canonical symbol form used inside the event bus and exit-manager state maps.
 *
 * The bot pulls symbol identifiers from three sources that disagree on shape:
 *   • Binance market data    — `SOLUSDT` (upper, no separators)
 *   • CoinDCX user-data WS   — `B-SOL_USDT` (`B-` prefix, `_` separator)
 *   • CoinDCX REST positions — `B-SOL_USDT`
 *   • Internal config/legacy — `solusdt`, `SOL`, `SOL_USDT`, mixed case
 *
 * Without a single normalizer, an exit manager that registered a position
 * keyed by `SOLUSDT` (from a Binance-derived fill event) never receives the
 * `execution.position.closed` published with `symbol: 'B-SOL_USDT'` from the
 * CoinDCX user-data stream. The position trails forever; orphan managers
 * keep firing close requests against a non-existent order; the adapter
 * returns `live_close_unknown_order` and the failure is silent.
 *
 * Rules:
 *   1. Strip a leading `B-` (CoinDCX futures prefix).
 *   2. Remove a single `_` (CoinDCX base/quote separator).
 *   3. Trim and upper-case.
 *
 * Examples:
 *   normalizeSymbol('B-SOL_USDT')   → 'SOLUSDT'
 *   normalizeSymbol('b-sol_usdt')   → 'SOLUSDT'
 *   normalizeSymbol('SOL_USDT')     → 'SOLUSDT'
 *   normalizeSymbol('solusdt')      → 'SOLUSDT'
 *   normalizeSymbol('  SOLUSDT  ')  → 'SOLUSDT'
 *   normalizeSymbol('1000PEPE_USDT')→ '1000PEPEUSDT'
 */
export const normalizeSymbol = (raw: unknown): string => {
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s) return '';
  return s.replace(/^B-/i, '').replace('_', '').toUpperCase();
};
