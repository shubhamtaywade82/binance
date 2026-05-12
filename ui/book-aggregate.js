export const floorToTick = (price, tick) => {
  const inv = 1 / tick;
  return Math.floor(price * inv + 1e-8) / inv;
}

export const ceilToTick = (price, tick) => {
  const inv = 1 / tick;
  return Math.ceil(price * inv - 1e-8) / inv;
}

export const aggregateBids = (bids, tick) => {
  const m = new Map();
  for (const { price, qty } of bids) {
    const p = floorToTick(price, tick);
    m.set(p, (m.get(p) ?? 0) + qty);
  }
  return [...m.entries()]
    .map(([price, q]) => ({ price, qty: q }))
    .sort((a, b) => b.price - a.price);
}

export const aggregateAsks = (asks, tick) => {
  const m = new Map();
  for (const { price, qty } of asks) {
    const p = ceilToTick(price, tick);
    m.set(p, (m.get(p) ?? 0) + qty);
  }
  return [...m.entries()]
    .map(([price, q]) => ({ price, qty: q }))
    .sort((a, b) => a.price - b.price);
}

export const defaultTickChoices = (refPrice) => {
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

const formatTickLabel = (tick) => {
  if (tick >= 1) return tick >= 10 ? String(tick) : tick.toFixed(1).replace(/\.0$/, '');
  const s = tick.toFixed(8).replace(/\.?0+$/, '');
  return s || String(tick);
}
