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

/**
 * Fetch symbol precision from Binance `GET /fapi/v1/exchangeInfo`.
 * Returns tick size, step size, and minimum order quantity for the given symbol.
 */
export async function fetchBinanceExchangeInfo(
  restBase: string,
  symbol: string,
): Promise<InstrumentPrecision | null> {
  const url = `${restBase}/fapi/v1/exchangeInfo`;
  const { data } = await axios.get<ExchangeInfo>(url, {
    timeout: 15_000,
    validateStatus: (s) => s === 200,
  });

  const symUpper = symbol.toUpperCase();
  const info = data.symbols.find((s) => s.symbol === symUpper);
  if (!info) return null;

  let tickSize = 0.01;
  let stepSize = 0.001;
  let minQty = 0.001;

  for (const f of info.filters) {
    if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
      const v = Number.parseFloat(f.tickSize);
      if (Number.isFinite(v) && v > 0) tickSize = v;
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

  return { tickSize, stepSize, minQty };
}
