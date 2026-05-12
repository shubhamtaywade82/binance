import axios from 'axios';
import type { InstrumentPrecision } from '../mapping/precision';

interface ExchangeFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
}

interface ExchangeSymbol {
  symbol: string;
  status: string;
  filters: ExchangeFilter[];
  pricePrecision: number;
  quantityPrecision: number;
}

interface ExchangeInfo {
  symbols: ExchangeSymbol[];
}

/** Extract lot + price filters from one `exchangeInfo.symbols[]` entry. */
export function parseInstrumentPrecisionFromExchangeSymbol(info: ExchangeSymbol): InstrumentPrecision | null {
  let tickSize = 0.01;
  let stepSize = 0.001;
  let minQty = 0.001;
  let sawPrice = false;

  for (const f of info.filters) {
    if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
      const v = Number.parseFloat(f.tickSize);
      if (Number.isFinite(v) && v > 0) {
        tickSize = v;
        sawPrice = true;
      }
    }
    if (f.filterType === 'LOT_SIZE') {
      if (f.stepSize) {
        const v = Number.parseFloat(f.stepSize);
        if (Number.isFinite(v) && v > 0) stepSize = v;
      }
      if (f.minQty) {
        const v = Number.parseFloat(f.minQty);
        if (Number.isFinite(v) && v > 0) minQty = v;
      }
    }
    if (f.filterType === 'MARKET_LOT_SIZE' && f.minQty) {
      const v = Number.parseFloat(f.minQty);
      if (Number.isFinite(v) && v > 0 && v > minQty) minQty = v;
    }
  }

  if (!sawPrice) return null;
  return { tickSize, stepSize, minQty };
}

/**
 * Fetch precision for many symbols in one `GET /fapi/v1/exchangeInfo` round-trip.
 * Keys in the returned map are uppercase Binance symbol names.
 */
export async function fetchBinanceExchangeInfoForSymbols(
  restBase: string,
  symbols: string[],
): Promise<Map<string, InstrumentPrecision>> {
  const out = new Map<string, InstrumentPrecision>();
  const want = new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean));
  if (want.size === 0) return out;

  const url = `${restBase}/fapi/v1/exchangeInfo`;
  const { data } = await axios.get<ExchangeInfo>(url, {
    timeout: 15_000,
    validateStatus: (s) => s === 200,
  });

  for (const row of data.symbols) {
    const symU = row.symbol.toUpperCase();
    if (!want.has(symU)) continue;
    const p = parseInstrumentPrecisionFromExchangeSymbol(row);
    if (p) out.set(symU, p);
  }
  return out;
}

/**
 * Fetch symbol precision from Binance `GET /fapi/v1/exchangeInfo`.
 * Returns tick size, step size, and minimum order quantity for the given symbol.
 */
export async function fetchBinanceExchangeInfo(
  restBase: string,
  symbol: string,
): Promise<InstrumentPrecision | null> {
  const map = await fetchBinanceExchangeInfoForSymbols(restBase, [symbol]);
  return map.get(symbol.trim().toUpperCase()) ?? null;
}
