import axios from 'axios';
import type { Candle, InstrumentMeta, InstrumentPrecision, OrderBookSnapshot, SymbolRef } from '@chart-studio/adapter-core';

export interface BinanceConfig {
  product: 'spot' | 'usdm';
  /** Override base URLs for testnet, paper, etc. */
  restBase?: string;
  wsBase?: string;
}

export const restBaseFor = (cfg: BinanceConfig): string => {
  if (cfg.restBase) return cfg.restBase;
  return cfg.product === 'spot' ? 'https://api.binance.com' : 'https://fapi.binance.com';
};

export const wsBaseFor = (cfg: BinanceConfig): string => {
  if (cfg.wsBase) return cfg.wsBase;
  return cfg.product === 'spot' ? 'wss://stream.binance.com:9443' : 'wss://fstream.binance.com';
};

const klinesPath = (cfg: BinanceConfig): string =>
  cfg.product === 'spot' ? '/api/v3/klines' : '/fapi/v1/klines';

const depthPath = (cfg: BinanceConfig): string =>
  cfg.product === 'spot' ? '/api/v3/depth' : '/fapi/v1/depth';

const exchangeInfoPath = (cfg: BinanceConfig): string =>
  cfg.product === 'spot' ? '/api/v3/exchangeInfo' : '/fapi/v1/exchangeInfo';

const normalizeKline = (row: unknown): Candle | null => {
  if (!Array.isArray(row) || row.length < 6) return null;
  const openTime = Number(row[0]);
  const open = Number(row[1]);
  const high = Number(row[2]);
  const low = Number(row[3]);
  const close = Number(row[4]);
  const volume = Number(row[5]);
  const closeTime = row[6] !== undefined ? Number(row[6]) : undefined;
  if (![openTime, open, high, low, close, volume].every(Number.isFinite)) return null;
  return { openTime, open, high, low, close, volume, closeTime, sealed: true };
};

export const fetchKlines = async (
  cfg: BinanceConfig,
  symbol: string,
  interval: string,
  opts: { limit?: number; startTime?: number; endTime?: number } = {},
): Promise<Candle[]> => {
  const url = `${restBaseFor(cfg)}${klinesPath(cfg)}`;
  const limit = Math.min(1500, Math.max(1, opts.limit ?? 500));
  const params: Record<string, string | number> = {
    symbol: symbol.toUpperCase(),
    interval,
    limit,
  };
  if (opts.startTime !== undefined) params.startTime = opts.startTime;
  if (opts.endTime !== undefined) params.endTime = opts.endTime;
  const { data } = await axios.get<unknown[][]>(url, { params, timeout: 15_000, validateStatus: (s) => s === 200 });
  if (!Array.isArray(data)) return [];
  const out: Candle[] = [];
  for (const row of data) {
    const c = normalizeKline(row);
    if (c) out.push(c);
  }
  return out;
};

export const fetchDepthSnapshot = async (
  cfg: BinanceConfig,
  symbol: string,
  limit = 100,
): Promise<OrderBookSnapshot | null> => {
  const url = `${restBaseFor(cfg)}${depthPath(cfg)}`;
  const maxLimit = cfg.product === 'spot' ? 5000 : 1000;
  const capped = Math.min(maxLimit, Math.max(5, limit));
  try {
    const { data } = await axios.get<{
      lastUpdateId: number;
      bids: [string, string][];
      asks: [string, string][];
    }>(url, { params: { symbol: symbol.toUpperCase(), limit: capped }, timeout: 15_000, validateStatus: (s) => s === 200 });
    if (typeof data?.lastUpdateId !== 'number' || !Array.isArray(data.bids) || !Array.isArray(data.asks)) return null;
    return {
      lastUpdateId: data.lastUpdateId,
      bids: data.bids.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
      asks: data.asks.map(([p, q]) => [Number(p), Number(q)] as [number, number]),
      ts: Date.now(),
    };
  } catch {
    return null;
  }
};

interface ExchangeFilter { filterType: string; tickSize?: string; stepSize?: string; minQty?: string }
interface ExchangeSymbol {
  symbol: string;
  status: string;
  filters: ExchangeFilter[];
  contractType?: string;
  baseAsset?: string;
  quoteAsset?: string;
}
interface ExchangeInfo { symbols: ExchangeSymbol[] }

const parsePrecision = (info: ExchangeSymbol): InstrumentPrecision | null => {
  let tickSize = 0.01;
  let stepSize = 0.001;
  let minQty = 0.001;
  let sawPrice = false;
  for (const f of info.filters) {
    if (f.filterType === 'PRICE_FILTER' && f.tickSize) {
      const v = Number.parseFloat(f.tickSize);
      if (Number.isFinite(v) && v > 0) { tickSize = v; sawPrice = true; }
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
  }
  if (!sawPrice) return null;
  return { tickSize, stepSize, minQty };
};

let cachedInfo: { providerId: string; ts: number; symbols: ExchangeSymbol[] } | null = null;
const INFO_TTL_MS = 60 * 60 * 1000;

export const loadExchangeInfo = async (cfg: BinanceConfig, providerId: string): Promise<ExchangeSymbol[]> => {
  if (cachedInfo && cachedInfo.providerId === providerId && Date.now() - cachedInfo.ts < INFO_TTL_MS) {
    return cachedInfo.symbols;
  }
  const url = `${restBaseFor(cfg)}${exchangeInfoPath(cfg)}`;
  const { data } = await axios.get<ExchangeInfo>(url, { timeout: 30_000, validateStatus: (s) => s === 200 });
  const symbols = Array.isArray(data.symbols) ? data.symbols.filter((s) => s.status === 'TRADING') : [];
  cachedInfo = { providerId, ts: Date.now(), symbols };
  return symbols;
};

export const toInstrumentMeta = (providerId: string, segmentLabel: string, info: ExchangeSymbol): InstrumentMeta => {
  const precision = parsePrecision(info) ?? undefined;
  return {
    provider: providerId,
    symbol: info.symbol,
    label: info.baseAsset && info.quoteAsset ? `${info.baseAsset}/${info.quoteAsset}` : info.symbol,
    segment: segmentLabel,
    precision,
    contractType: info.contractType,
    intervals: ['1m', '5m', '15m', '1h', '4h', '1d'],
  };
};

export const toSymbolRef = (providerId: string, segmentLabel: string, info: ExchangeSymbol): SymbolRef => ({
  provider: providerId,
  symbol: info.symbol,
  label: info.baseAsset && info.quoteAsset ? `${info.baseAsset}/${info.quoteAsset}` : info.symbol,
  segment: segmentLabel,
});
