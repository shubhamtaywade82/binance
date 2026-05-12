const clampInt = (n, lo, hi) => {
  const x = Math.trunc(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

const parsed = Number.parseInt(String(import.meta.env?.VITE_LTP_DECIMAL_PLACES ?? '3'), 10);
const ENV_DEFAULT_PLACES = clampInt(parsed, 1, 8);

let ltpDecimalPlaces = ENV_DEFAULT_PLACES;
let ltpTickScale = 10 ** ltpDecimalPlaces;

export const setLtpDecimalPlacesFromServer = (n) => {
  if (n == null || !Number.isFinite(n)) {
    ltpDecimalPlaces = ENV_DEFAULT_PLACES;
  } else {
    ltpDecimalPlaces = clampInt(n, 1, 8);
  }
  ltpTickScale = 10 ** ltpDecimalPlaces;
}

export const ltpTicksFromPrice = (p) => {
  return Math.round(Number(p) * ltpTickScale);
}

export const ltpPriceFromTicks = (ticks) => {
  return ticks / ltpTickScale;
}

export const fmtLtpDisplay = (p) => {
  if (p == null || !Number.isFinite(p)) return '—';
  return p.toFixed(ltpDecimalPlaces);
}

export const getLtpDecimalPlaces = () => {
  return ltpDecimalPlaces;
}
