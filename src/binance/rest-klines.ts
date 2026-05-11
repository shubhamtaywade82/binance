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
  /** Inclusive lower bound (ms). */
  startTime?: number;
  /** Exclusive upper bound (ms). */
  endTime?: number;
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
  const query: Record<string, string | number> = {
    symbol: params.symbol.toUpperCase(),
    interval: params.interval,
    limit,
  };
  if (params.startTime !== undefined) query.startTime = params.startTime;
  if (params.endTime !== undefined) query.endTime = params.endTime;
  const { data } = await axios.get<unknown[][]>(url, {
    params: query,
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

export interface FetchKlinesWindowParams {
  symbol: string;
  interval: string;
  startTime: number;
  endTime: number;
  /** Per-request page size (max 1500). */
  limit?: number;
}

/**
 * Walks Binance klines in chronological order for an intraday or multi-day window.
 * Uses `startTime` paging until `endTime` is reached or the API returns an empty page.
 */
export async function fetchBinanceKlinesWindow(
  cfg: AppConfig,
  params: FetchKlinesWindowParams,
): Promise<Candle[]> {
  const page = Math.min(1500, Math.max(1, params.limit ?? 1500));
  const out: Candle[] = [];
  let start = params.startTime;
  const end = params.endTime;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return out;

  while (start < end) {
    const batch = await fetchBinanceKlines(cfg, {
      symbol: params.symbol,
      interval: params.interval,
      limit: page,
      startTime: start,
      endTime: end,
    });
    if (batch.length === 0) break;
    for (const c of batch) {
      if (c.openTime >= end) continue;
      out.push(c);
    }
    const last = batch[batch.length - 1]!;
    const nextStart = last.openTime + 1;
    if (nextStart <= start) break;
    start = nextStart;
    if (batch.length < page) break;
  }
  return out;
}

/** Fetch the same wall-clock span for several intervals (e.g. 1m, 15m, 1h) for indicator stacks. */
export async function fetchBinanceKlinesMultiInterval(
  cfg: AppConfig,
  symbol: string,
  intervals: string[],
  startTime: number,
  endTime: number,
  limitPerPage?: number,
): Promise<Record<string, Candle[]>> {
  const result: Record<string, Candle[]> = {};
  for (const interval of intervals) {
    result[interval] = await fetchBinanceKlinesWindow(cfg, {
      symbol,
      interval,
      startTime,
      endTime,
      limit: limitPerPage,
    });
  }
  return result;
}
