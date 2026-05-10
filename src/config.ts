import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const BinanceProduct = z.enum(['usdm', 'spot']);

const numFromString = (def: number) =>
  z
    .union([z.number(), z.string()])
    .default(def)
    .transform((v) => (typeof v === 'number' ? v : Number.parseFloat(v)))
    .pipe(z.number().finite());

const boolFromString = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) => (typeof v === 'boolean' ? v : v.toLowerCase() === 'true'));

export const AppConfigSchema = z.object({
  BINANCE_PRODUCT: BinanceProduct.default('usdm'),
  BINANCE_REST_BASE: z.string().url().optional(),
  BINANCE_WS_BASE: z.string().url().optional(),
  BINANCE_SYMBOL: z.string().min(1).default('SOLUSDT'),
  BINANCE_KLINE_INTERVAL: z.string().default('15m'),
  BINANCE_HTF_INTERVAL: z.string().default('1h'),
  COINDCX_API_KEY: z.string().default(''),
  COINDCX_API_SECRET: z.string().default(''),
  API_BASE_URL: z.string().url().default('https://api.coindcx.com'),
  PUBLIC_BASE_URL: z.string().url().default('https://public.coindcx.com'),
  COINDCX_PAIR: z.string().min(1).default('B-SOL_USDT'),
  READ_ONLY: z
    .string()
    .default('true')
    .transform((s) => s.toLowerCase() !== 'false'),
  EXECUTION_ENABLED: z
    .string()
    .default('false')
    .transform((s) => s.toLowerCase() === 'true'),

  /** Seconds between heartbeat logs (mark + biases). 0 = disable. */
  LOG_HEARTBEAT_SEC: z
    .string()
    .optional()
    .default('60')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 0) return 60;
      return Math.min(3600, n);
    }),

  /** After WS open, warn if no LTP/mark yet (seconds). 0 = disable. */
  LTP_CONNECT_WARN_SEC: z
    .string()
    .optional()
    .default('15')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 0) return 15;
      return Math.min(120, n);
    }),

  LEVERAGE: numFromString(10),
  CAPITAL_PER_TRADE: numFromString(20000),
  CAPITAL_PER_TRADE_INR: numFromString(20000),
  INR_PER_USDT: numFromString(85),
  TARGET_PNL_PCT: numFromString(0.10),
  STOP_LOSS_PCT: numFromString(0.05),
  MIN_CONFIDENCE: numFromString(0.65),
  MIN_SMC_SCORE: numFromString(2),
  TAKER_FEE: numFromString(0.0005),
  MAKER_FEE: numFromString(0.0002),
  FUNDING_FEE_EST: numFromString(0.0001),
  MARGIN_CURRENCY: z.string().default('USDT'),
  USE_SMC: boolFromString(true),
  TRADES_CSV_PATH: z.string().default('./logs/trades.csv'),
  TRADE_LOG_PATH: z.string().default('./logs/trades.csv'),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function loadConfig(): AppConfig {
  return AppConfigSchema.parse(process.env);
}

export function binanceRestBase(cfg: AppConfig): string {
  if (cfg.BINANCE_REST_BASE) return cfg.BINANCE_REST_BASE;
  return cfg.BINANCE_PRODUCT === 'spot'
    ? 'https://api.binance.com'
    : 'https://fapi.binance.com';
}

export function binanceWsBase(cfg: AppConfig): string {
  if (cfg.BINANCE_WS_BASE) return cfg.BINANCE_WS_BASE;
  return cfg.BINANCE_PRODUCT === 'spot'
    ? 'wss://stream.binance.com:9443'
    : 'wss://fstream.binance.com';
}
