import axios, { type AxiosInstance } from 'axios';
import type { Candle, OrderBookSnapshot } from '@chart-studio/adapter-core';
import type { DhanInstrument } from './instruments';
import type { TokenProvider } from './token-provider';
export type { DhanCreds } from './token-provider';

const BASE_URL = 'https://api.dhan.co';

/**
 * Build an Axios instance whose Authorization headers are stamped from
 * the TokenProvider on every request. On 401 we invalidate and let the
 * caller retry with fresh creds.
 */
export const createClient = (tokens: TokenProvider): AxiosInstance => {
  const client = axios.create({
    baseURL: BASE_URL,
    timeout: 30_000,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  client.interceptors.request.use(async (cfg) => {
    const creds = await tokens.get();
    cfg.headers.set('access-token', creds.accessToken);
    cfg.headers.set('client-id', creds.clientId);
    return cfg;
  });
  client.interceptors.response.use(undefined, async (err) => {
    if (err?.response?.status === 401) {
      tokens.invalidate();
    }
    throw err;
  });
  return client;
};

interface HistoricalResponse {
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  timestamp?: number[];
  open_interest?: number[];
}

const zip = (resp: HistoricalResponse, intervalSec: number): Candle[] => {
  const ts = resp.timestamp ?? [];
  const o = resp.open ?? [];
  const h = resp.high ?? [];
  const l = resp.low ?? [];
  const c = resp.close ?? [];
  const v = resp.volume ?? [];
  const n = Math.min(ts.length, o.length, h.length, l.length, c.length, v.length);
  const out: Candle[] = [];
  for (let i = 0; i < n; i += 1) {
    const openTime = (ts[i] ?? 0) * 1000;
    const candle: Candle = {
      openTime,
      open: o[i]!,
      high: h[i]!,
      low: l[i]!,
      close: c[i]!,
      volume: v[i]!,
      closeTime: openTime + intervalSec * 1000 - 1,
      sealed: true,
    };
    out.push(candle);
  }
  return out;
};

const intervalToMinutes = (interval: string): number | 'daily' => {
  const i = interval.trim().toUpperCase();
  if (i === '1D' || i === 'D' || i === 'DAY' || i === 'DAILY') return 'daily';
  const num = Number(i.replace(/[^0-9]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return 1;
  // Dhan intraday supports 1, 5, 15, 25, 60
  if ([1, 5, 15, 25, 60].includes(num)) return num;
  if (num < 5) return 1;
  if (num < 15) return 5;
  if (num < 25) return 15;
  if (num < 60) return 25;
  return 60;
};

const formatDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const formatDateTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export const fetchCandles = async (
  client: AxiosInstance,
  ins: DhanInstrument,
  interval: string,
  opts: { limit?: number; startTime?: number; endTime?: number } = {},
): Promise<Candle[]> => {
  const mode = intervalToMinutes(interval);
  const endTime = opts.endTime ?? Date.now();
  const limit = Math.min(2000, Math.max(50, opts.limit ?? 500));
  const intervalSec = mode === 'daily' ? 86_400 : mode * 60;
  const startTime = opts.startTime ?? endTime - limit * intervalSec * 1000;

  if (mode === 'daily') {
    const { data } = await client.post<HistoricalResponse>('/v2/charts/historical', {
      securityId: ins.securityId,
      exchangeSegment: ins.exchangeSegment,
      instrument: ins.instrumentType,
      fromDate: formatDate(startTime),
      toDate: formatDate(endTime),
    });
    return zip(data, intervalSec);
  }

  // Intraday: cap at 90 days, page if needed
  const NINETY = 90 * 24 * 60 * 60 * 1000;
  const out: Candle[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const segEnd = Math.min(endTime, cursor + NINETY);
    const { data } = await client.post<HistoricalResponse>('/v2/charts/intraday', {
      securityId: ins.securityId,
      exchangeSegment: ins.exchangeSegment,
      instrument: ins.instrumentType,
      interval: mode,
      fromDate: formatDateTime(cursor),
      toDate: formatDateTime(segEnd),
    });
    out.push(...zip(data, intervalSec));
    if (segEnd >= endTime) break;
    cursor = segEnd + 1;
  }
  return out;
};

interface FullDepthResponse {
  // Dhan's market depth endpoint returns nested objects keyed by exchangeSegment.
  // Shape: { [segment]: { [securityId]: { last_trade_price, depth: { buy: [{price, quantity, orders}], sell: [...] } } } }
  [segment: string]: Record<string, {
    last_trade_price?: number;
    depth?: {
      buy?: Array<{ price: number; quantity: number; orders?: number }>;
      sell?: Array<{ price: number; quantity: number; orders?: number }>;
    };
  }>;
}

export const fetchMarketDepth = async (
  client: AxiosInstance,
  ins: DhanInstrument,
): Promise<OrderBookSnapshot | null> => {
  try {
    const { data } = await client.post<FullDepthResponse>('/v2/marketfeed/depth', {
      [ins.exchangeSegment]: [Number(ins.securityId)],
    });
    const row = data?.[ins.exchangeSegment]?.[ins.securityId];
    if (!row?.depth) return null;
    const bids = (row.depth.buy ?? []).map((b) => [Number(b.price), Number(b.quantity)] as [number, number]);
    const asks = (row.depth.sell ?? []).map((a) => [Number(a.price), Number(a.quantity)] as [number, number]);
    return {
      lastUpdateId: Date.now(),
      bids,
      asks,
      ts: Date.now(),
    };
  } catch {
    return null;
  }
};
