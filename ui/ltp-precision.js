/**
 * Live LTP line + forming-candle step size: 10^-N (N decimal places).
 *
 * When the dashboard bot sends `ltpDecimalPlaces` (from Binance `tickSize` per symbol),
 * that value replaces the build-time default. Otherwise use `VITE_LTP_DECIMAL_PLACES`
 * in `.env` (1–8); Vite inlines at build/dev time — restart `npm run ui:dev` after changes.
 */

function clampInt(n, lo, hi) {
  const x = Math.trunc(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

const parsed = Number.parseInt(String(import.meta.env?.VITE_LTP_DECIMAL_PLACES ?? '3'), 10);
const ENV_DEFAULT_PLACES = clampInt(parsed, 1, 8);

let ltpDecimalPlaces = ENV_DEFAULT_PLACES;
let ltpTickScale = 10 ** ltpDecimalPlaces;

/**
 * @param {number | null | undefined} n Decimal places from server, or null to use env default.
 */
export function setLtpDecimalPlacesFromServer(n) {
  if (n == null || !Number.isFinite(n)) {
    ltpDecimalPlaces = ENV_DEFAULT_PLACES;
  } else {
    ltpDecimalPlaces = clampInt(n, 1, 8);
  }
  ltpTickScale = 10 ** ltpDecimalPlaces;
}

export function ltpTicksFromPrice(p) {
  return Math.round(Number(p) * ltpTickScale);
}

export function ltpPriceFromTicks(ticks) {
  return ticks / ltpTickScale;
}

export function fmtLtpDisplay(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  return p.toFixed(ltpDecimalPlaces);
}
