export interface InstrumentPrecision {
  tickSize: number;
  stepSize: number;
  minQty: number;
}

const num = (x: unknown): number | undefined => {
  const n = typeof x === 'string' ? Number.parseFloat(x) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const extractPrecisionFromInstrument = (payload: unknown): InstrumentPrecision => {
  const defaults = { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 };
  if (!payload || typeof payload !== 'object') return defaults;
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [root, root.data, root.result];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const tickSize =
      num(o.tick_size) ??
      num(o.tickSize) ??
      num(o.price_tick) ??
      num(o.min_price_increment);
    const stepSize =
      num(o.quantity_step) ??
      num(o.stepSize) ??
      num(o.lot_size) ??
      num(o.lotSize);
    const minQty =
      num(o.min_quantity) ??
      num(o.minQuantity) ??
      num(o.min_order_size) ??
      num(o.min_order_qty);
    if (tickSize && stepSize && minQty) {
      return { tickSize, stepSize, minQty };
    }
    if (tickSize && stepSize) {
      return { tickSize, stepSize, minQty: minQty ?? stepSize };
    }
  }
  return defaults;
}

export const floorToStep = (value: number, step: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const n = Math.floor(value / step) * step;
  const decimals = `${step}`.includes('.') ? `${step}`.split('.')[1].length : 0;
  return Number(n.toFixed(Math.min(12, decimals)));
}

export const roundToTick = (price: number, tick: number): number => {
  if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return price;
  const decimals = `${tick}`.includes('.') ? `${tick}`.split('.')[1].length : 0;
  return Number((Math.round(price / tick) * tick).toFixed(Math.min(12, decimals)));
}

/** Decimal places for displaying prices: matches Binance `PRICE_FILTER.tickSize` (no sub-tick padding). */
export const ltpDisplayDecimalPlaces = (tickSize: number, opts: { min?: number; max?: number; fallback?: number } = {}): number => {
  const min = opts.min ?? 0;
  const max = opts.max ?? 8;
  const fallback = Math.min(max, Math.max(min, opts.fallback ?? 2));
  if (!Number.isFinite(tickSize) || tickSize <= 0) return fallback;
  const trimmed = tickSize.toFixed(12).replace(/\.?0+$/, '');
  const dot = trimmed.indexOf('.');
  const frac = dot < 0 ? 0 : trimmed.slice(dot + 1).length;
  return Math.min(max, Math.max(min, frac));
}
