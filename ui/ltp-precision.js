/**
 * Live LTP line + forming-candle step size: 10^-N (N decimal places).
 * Set `VITE_LTP_DECIMAL_PLACES` in repo `.env` (1–8). Vite inlines at build/dev time — restart `npm run ui:dev` after changes.
 */

function clampInt(n, lo, hi) {
  const x = Math.trunc(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

const parsed = Number.parseInt(String(import.meta.env?.VITE_LTP_DECIMAL_PLACES ?? '3'), 10);
export const LTP_DECIMAL_PLACES = clampInt(parsed, 1, 8);
export const LTP_TICK_SCALE = 10 ** LTP_DECIMAL_PLACES;

export function ltpTicksFromPrice(p) {
  return Math.round(Number(p) * LTP_TICK_SCALE);
}

export function ltpPriceFromTicks(ticks) {
  return ticks / LTP_TICK_SCALE;
}

export function fmtLtpDisplay(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  return p.toFixed(LTP_DECIMAL_PLACES);
}
