import axios from 'axios';
import { binanceRestBase, isBinanceUsdmProduct, type AppConfig } from '../config';

/** Binance USD-M `GET /fapi/v1/premiumIndex` single-symbol row. */
export interface PremiumIndexRow {
  symbol?: string;
  markPrice?: string;
  time?: number;
}

export const fetchUsdmMarkFromRest = async (cfg: AppConfig, symbolUpper: string): Promise<{ markPrice: number; eventTime: number } | null> => {
  if (!isBinanceUsdmProduct(cfg.BINANCE_PRODUCT)) return null;
  const base = binanceRestBase(cfg);
  const url = `${base}/fapi/v1/premiumIndex`;
  const { data } = await axios.get<PremiumIndexRow>(url, {
    params: { symbol: symbolUpper.toUpperCase() },
    timeout: 10_000,
    validateStatus: (s) => s === 200,
  });
  const markPrice = Number(data.markPrice);
  const eventTime = typeof data.time === 'number' ? data.time : Date.now();
  if (!Number.isFinite(markPrice)) return null;
  return { markPrice, eventTime };
}
