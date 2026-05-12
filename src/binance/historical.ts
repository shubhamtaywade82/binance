import axios from 'axios';
import type { AppConfig } from '../config';
import { binanceRestBase } from '../config';
import type { Candle } from '../types';
import { normalizeBinanceKlineRow } from './rest-klines';

export interface FetchHistoricalParams {
  symbol: string;
  interval: string;
  startMs: number;
  endMs: number;
  /** Cap returned bars (after dedupe). */
  maxBars?: number;
  /** Override per-page sleep (ms). Tests can pass 0. */
  pageDelayMs?: number;
}

const PAGE_LIMIT = 1500;

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => setTimeout(r, ms));
}

export const fetchHistoricalKlines = async (cfg: AppConfig, params: FetchHistoricalParams): Promise<Candle[]> => {
  const base = binanceRestBase(cfg);
  const path = cfg.BINANCE_PRODUCT === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';
  const url = `${base}${path}`;
  const sym = params.symbol.toUpperCase();
  const pageDelayMs = params.pageDelayMs ?? 50;
  const out: Candle[] = [];
  const seen = new Set<number>();

  let cursor = params.startMs;
  let page = 0;
  while (cursor < params.endMs) {
    const { data } = await axios.get<unknown[][]>(url, {
      params: {
        symbol: sym,
        interval: params.interval,
        startTime: cursor,
        endTime: params.endMs,
        limit: PAGE_LIMIT,
      },
      timeout: 20_000,
      validateStatus: (s) => s === 200,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    let lastClose = cursor;
    for (const row of data) {
      const c = normalizeBinanceKlineRow(row);
      if (!c) continue;
      if (seen.has(c.openTime)) continue;
      seen.add(c.openTime);
      out.push(c);
      if (typeof c.closeTime === 'number' && c.closeTime > lastClose) lastClose = c.closeTime;
      else if (c.openTime > lastClose) lastClose = c.openTime;
      if (params.maxBars && out.length >= params.maxBars) break;
    }
    if (params.maxBars && out.length >= params.maxBars) break;
    if (data.length < PAGE_LIMIT) break;
    const next = lastClose + 1;
    if (next <= cursor) break;
    cursor = next;
    page += 1;
    if (pageDelayMs > 0) await sleep(pageDelayMs);
    if (page > 1000) break;
  }

  out.sort((a, b) => a.openTime - b.openTime);
  if (params.maxBars && out.length > params.maxBars) out.splice(params.maxBars);
  return out;
}
