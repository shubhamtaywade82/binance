import axios from 'axios';
import type { AppConfig } from '../config';
import { binanceRestBase } from '../config';

export interface DepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

export const fetchBinanceDepthSnapshot = async (cfg: AppConfig, symbolUpper: string, limit = 1000): Promise<DepthSnapshot | null> => {
  const base = binanceRestBase(cfg);
  const path = cfg.BINANCE_PRODUCT === 'spot' ? '/api/v3/depth' : '/fapi/v1/depth';
  const maxLimit = cfg.BINANCE_PRODUCT === 'spot' ? 5000 : 1000;
  const cap = Math.min(maxLimit, Math.max(5, limit));
  const url = `${base}${path}`;
  try {
    const { data } = await axios.get<{
      lastUpdateId: number;
      bids: [string, string][];
      asks: [string, string][];
    }>(url, {
      params: { symbol: symbolUpper.toUpperCase(), limit: cap },
      timeout: 15_000,
      validateStatus: (s) => s === 200,
    });
    if (
      typeof data?.lastUpdateId !== 'number' ||
      !Array.isArray(data.bids) ||
      !Array.isArray(data.asks)
    ) {
      return null;
    }
    return {
      lastUpdateId: data.lastUpdateId,
      bids: data.bids,
      asks: data.asks,
    };
  } catch {
    return null;
  }
}
