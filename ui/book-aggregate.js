/**
 * Merge raw depth steps into display ticks (floor bids, ceil asks).
 * @typedef {{ price: number; qty: number }} Level
 */

/** @param {number} price @param {number} tick */
export function floorToTick(price, tick) {
  const inv = 1 / tick;
  return Math.floor(price * inv + 1e-8) / inv;
}

/** @param {number} price @param {number} tick */
export function ceilToTick(price, tick) {
  const inv = 1 / tick;
  return Math.ceil(price * inv - 1e-8) / inv;
}

/**
 * @param {Level[]} bids highest first
 * @param {number} tick
 * @returns {Level[]}
 */
export function aggregateBids(bids, tick) {
  const m = new Map();
  for (const { price, qty } of bids) {
    const p = floorToTick(price, tick);
    m.set(p, (m.get(p) ?? 0) + qty);
  }
  return [...m.entries()]
    .map(([price, q]) => ({ price, qty: q }))
    .sort((a, b) => b.price - a.price);
}

/**
 * @param {Level[]} asks lowest first
 * @param {number} tick
 * @returns {Level[]}
 */
export function aggregateAsks(asks, tick) {
  const m = new Map();
  for (const { price, qty } of asks) {
    const p = ceilToTick(price, tick);
    m.set(p, (m.get(p) ?? 0) + qty);
  }
  return [...m.entries()]
    .map(([price, q]) => ({ price, qty: q }))
    .sort((a, b) => a.price - b.price);
}

/**
 * @param {number} refPrice mid-ish price for choosing a sensible default tick
 * @returns {{ value: string; label: string; tick: number }[]}
 */
export function defaultTickChoices(refPrice) {
  const p = refPrice > 0 ? refPrice : 100;
  const base = [1000, 100, 10, 1, 0.1, 0.01, 0.001, 0.0001, 0.00001];
  const ticks = base.filter((t) => t <= p * 2 || t <= 1);
  const uniq = [...new Set(ticks)].sort((a, b) => b - a);
  return uniq.map((tick) => ({
    value: String(tick),
    tick,
    label: formatTickLabel(tick),
  }));
}

/** @param {number} tick */
function formatTickLabel(tick) {
  if (tick >= 1) return tick >= 10 ? String(tick) : tick.toFixed(1).replace(/\.0$/, '');
  const s = tick.toFixed(8).replace(/\.?0+$/, '');
  return s || String(tick);
}
