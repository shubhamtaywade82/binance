import axios from 'axios';
import type { AppConfig } from '../config';
import { binanceRestBase } from '../config';
import type { Candle } from '../types';

/** Binance kline array shape: [ openTime, open, high, low, close, volume, closeTime, ... ] */
export function normalizeBinanceKlineRow(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const openTime = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  const closeTime = row[6] !== undefined ? Number(row[6]) : undefined;
  if (![openTime, open, high, low, close, volume].every(Number.isFinite)) return null;
  return { openTime, open, high, low, close, volume, closeTime };
}

export interface FetchKlinesParams {
  symbol: string;
  interval: string;
  limit?: number;
}

/**
 * Public klines from Binance (spot or USD-M futures).
 * @see https://developers.binance.com/docs
 */
export async function fetchBinanceKlines(
  cfg: AppConfig,
  params: FetchKlinesParams,
): Promise<Candle[]> {
  const base = binanceRestBase(cfg);
  const path = cfg.BINANCE_PRODUCT === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
  const limit = Math.min(1500, Math.max(1, params.limit ?? 500));
  const url = `${base}${path}`;
  const { data } = await axios.get<unknown[][]>(url, {
    params: {
      symbol: params.symbol.toUpperCase(),
      interval: params.interval,
      limit,
    },
    timeout: 15_000,
    validateStatus: (s) => s === 200,
  });
  if (!Array.isArray(data)) return [];
  const out: Candle[] = [];
  for (const row of data) {
    const c = normalizeBinanceKlineRow(row);
    if (c) out.push(c);
  }
  return out;
}
