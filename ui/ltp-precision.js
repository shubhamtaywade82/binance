const clampInt = (n, lo, hi) => {
  const x = Math.trunc(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** One extra decimal vs exchange tick so LTP line / forming close can step smoothly between ticks. */
const smoothPlacesFromDisplay = (display) => clampInt(display + 1, 1, 8);

const parsed = Number.parseInt(String(import.meta.env?.VITE_LTP_DECIMAL_PLACES ?? '2'), 10);
const ENV_DEFAULT_DISPLAY = clampInt(parsed, 0, 8);

let displayDecimalPlaces = ENV_DEFAULT_DISPLAY;
let ltpTickScale = 10 ** smoothPlacesFromDisplay(displayDecimalPlaces);

const syncSmoothScale = () => {
  ltpTickScale = 10 ** smoothPlacesFromDisplay(displayDecimalPlaces);
};

/**
 * @param {number | null | undefined} n Display decimal places (Binance tick fractional digits). Null resets to env default.
 */
export const setLtpDecimalPlacesFromServer = (n) => {
  if (n == null || !Number.isFinite(n)) {
    displayDecimalPlaces = ENV_DEFAULT_DISPLAY;
  } else {
    displayDecimalPlaces = clampInt(n, 0, 8);
  }
  syncSmoothScale();
}

export const ltpTicksFromPrice = (p) => {
  return Math.round(Number(p) * ltpTickScale);
}

export const ltpPriceFromTicks = (ticks) => {
  return ticks / ltpTickScale;
}

/** Tick-aligned formatting for chart axis, order book, tape, sentiment. */
export const fmtLtpDisplay = (p) => {
  if (p == null || !Number.isFinite(p)) return '—';
  return p.toFixed(displayDecimalPlaces);
}

/** Matches chart LTP tick scale (`display + 1`) — top bar LTP, mark, bid, ask. */
export const fmtLtpMovement = (p) => {
  if (p == null || !Number.isFinite(p)) return '—';
  return p.toFixed(smoothPlacesFromDisplay(displayDecimalPlaces));
}

/** Spread on top bar: one extra decimal past movement so small spreads stay readable. */
export const fmtSpreadMovement = (spread) => {
  if (spread == null || !Number.isFinite(spread)) return '—';
  const m = smoothPlacesFromDisplay(displayDecimalPlaces);
  const d = Math.min(8, Math.max(1, m + 1));
  return spread.toFixed(d);
}

/** Exchange default (tick) decimal places — use for DOM that must not show sub-tick digits. */
export const getLtpDecimalPlaces = () => {
  return displayDecimalPlaces;
}
