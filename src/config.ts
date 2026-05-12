import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { normalizeTradingAsset, TRADING_ASSET_PRESETS } from './config/asset-presets';

loadDotenv();

export type { TradingAsset } from './config/asset-presets';

const BinanceProduct = z.enum(['usdm', 'spot']);
const ExecutionModeEnum = z.enum(['paper', 'live']);

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
  /**
   * Primary control: `sol` | `eth` | `btc` sets `BINANCE_SYMBOL` + `COINDCX_PAIR` automatically.
   * Use `custom` with explicit `BINANCE_SYMBOL` and `COINDCX_PAIR` in env for other markets.
   */
  TRADING_ASSET: z
    .string()
    .default('sol')
    .transform((s) => normalizeTradingAsset(s)),
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

  /**
   * Master switch for `PositionManager` → execution adapter (paper or live).
   * Default **true**: with **`EXECUTION_MODE=paper`** (default), fills are **simulated locally** — no CoinDCX order API and no Binance trading API.
   * Set **false** for signals-only (no paper positions). Live exchange orders still require **`EXECUTION_MODE=live`**, **`READ_ONLY=false`**, and API keys.
   * Legacy: `EXECUTION_ENABLED` is honored if `PLACE_ORDER` is unset.
   */
  PLACE_ORDER: z.preprocess((val: unknown) => {
    if (val !== undefined && val !== '') return val;
    if (process.env.PLACE_ORDER !== undefined && process.env.PLACE_ORDER !== '') return process.env.PLACE_ORDER;
    if (process.env.EXECUTION_ENABLED !== undefined && process.env.EXECUTION_ENABLED !== '') {
      return process.env.EXECUTION_ENABLED;
    }
    return 'true';
  }, boolFromString(true)),

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

  /**
   * USD-M only: poll `GET /fapi/v1/premiumIndex` for mark/LTP when WS is silent.
   * 0 = disable (WS only). Default 5s — REST often works when `fstream` push is blocked.
   */
  USDM_MARK_REST_POLL_SEC: z
    .string()
    .optional()
    .default('5')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 0) return 5;
      return Math.min(600, n);
    }),

  LEVERAGE: numFromString(10),
  CAPITAL_PER_TRADE: numFromString(20000),
  CAPITAL_PER_TRADE_INR: numFromString(20000),
  INR_PER_USDT: numFromString(85),
  TARGET_PNL_PCT: numFromString(0.10),
  STOP_LOSS_PCT: numFromString(0.05),
  /** Take-profit distance as underlying price move (default 1.5% capture profile). */
  TP_PRICE_PCT: numFromString(0.015),
  /** Stop-loss distance as underlying price move. */
  SL_PRICE_PCT: numFromString(0.01),
  MIN_CONFIDENCE: numFromString(0.65),
  MIN_SMC_SCORE: numFromString(2),
  TAKER_FEE: numFromString(0.0005),
  MAKER_FEE: numFromString(0.0002),
  FUNDING_FEE_EST: numFromString(0.0001),
  MARGIN_CURRENCY: z.string().default('USDT'),
  USE_SMC: boolFromString(true),

  USE_SMC_CONFLUENCE: boolFromString(true),
  SMC_CONFLUENCE_MODE: z
    .union([z.enum(['standard', 'sniper']), z.string()])
    .default('standard')
    .transform((v) => (String(v).toLowerCase() === 'sniper' ? 'sniper' : 'standard'))
    .pipe(z.enum(['standard', 'sniper'])),
  SMC_CONFLUENCE_MIN_STANDARD: numFromString(3),
  SMC_CONFLUENCE_MIN_SNIPER: numFromString(4),
  SMC_CONFLUENCE_TARGET_PCT: numFromString(0.015),

  /**
   * Multi-timeframe SMC stack (5m execution close, 15m/1h/4h/1d filters). Same engine for SOL/ETH/BTC presets.
   * Legacy env: `USE_SOL_MTF_STRATEGY` still honored if set (overrides default when present).
   */
  USE_SOL_MTF_STRATEGY: z.preprocess((val) => {
    if (process.env.USE_SOL_MTF_STRATEGY !== undefined && (val === undefined || val === '')) {
      return process.env.USE_SOL_MTF_STRATEGY;
    }
    return val ?? 'true';
  }, boolFromString(true)),
  TRADES_CSV_PATH: z.string().default('./logs/trades.csv'),
  TRADE_LOG_PATH: z.string().default('./logs/trades.csv'),

  /** Append NDJSON log lines (empty = stdout/stderr only). */
  APP_LOG_PATH: z.string().default('./logs/app.ndjson'),

  EXECUTION_MODE: z
    .union([ExecutionModeEnum, z.string()])
    .default('paper')
    .transform((v) => {
      const s = String(v).toLowerCase();
      return s === 'live' ? 'live' : 'paper';
    })
    .pipe(ExecutionModeEnum),
  PAPER_INITIAL_BALANCE_USDT: numFromString(10_000),
  PAPER_MAINT_MARGIN: numFromString(0.005),
  PAPER_BASE_SLIPPAGE_BPS: numFromString(2),
  PAPER_LATENCY_MS: numFromString(150),
  PAPER_LEDGER_DIR: z.string().default('./paper'),
  PAPER_FUNDING_POLL_SEC: numFromString(300),
  PAPER_EQUITY_SNAPSHOT_SEC: numFromString(5),

  /** Comma-separated kline timeframes for the multiplex feed. First = execution (LTF) close. */
  BINANCE_TIMEFRAMES: z
    .string()
    .default('5m,15m,1h,4h,1d')
    .transform((s) =>
      s
        .split(',')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0),
    )
    .pipe(z.array(z.string()).min(1)),
  BINANCE_HISTORY_BARS: z
    .union([z.number(), z.string()])
    .default(500)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(50).max(2000)),
  BINANCE_DEPTH_LEVELS: z
    .union([z.number(), z.string()])
    .default(20)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .pipe(z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(20)])),
  BINANCE_DEPTH_SPEED: z.enum(['100ms', '500ms']).default('100ms'),
  BINANCE_USE_AGGTRADE: boolFromString(true),
  BINANCE_USE_BOOKTICKER: boolFromString(true),
  BINANCE_USE_MARK_PRICE: boolFromString(true),
  /** Stream liquidation orders (`@forceOrder`) for SMC liquidity sweep detection. USD-M only. */
  BINANCE_USE_FORCE_ORDER: boolFromString(false),
  BINANCE_WS_RECONNECT_HOURS: numFromString(23),

  /**
   * USD-M Futures **testnet** (derivatives demo): REST `demo-fapi.binance.com`, WS `fstream.binancefuture.com`.
   * Ignored when `BINANCE_PRODUCT=spot`. Overrides ignored if `BINANCE_REST_BASE` / `BINANCE_WS_BASE` are set.
   * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
   */
  BINANCE_FUTURES_TESTNET: boolFromString(false),

  /**
   * Binance HMAC-SHA256 REST trading credentials.
   * Required when `BINANCE_EXECUTION_ADAPTER=true` (live orders via Binance FAPI).
   * Enable Futures trading on the API key and restrict by IP for safety.
   */
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),

  /**
   * When true, live execution uses Binance FAPI directly (HMAC REST + private WS) instead of CoinDCX.
   * Requires `BINANCE_API_KEY` + `BINANCE_API_SECRET`, `EXECUTION_MODE=live`, `READ_ONLY=false`.
   */
  BINANCE_EXECUTION_ADAPTER: boolFromString(false),

  /**
   * Enable the Binance private user-data WebSocket stream (ORDER_TRADE_UPDATE, ACCOUNT_UPDATE).
   * Automatically enabled when `BINANCE_EXECUTION_ADAPTER=true` and `EXECUTION_MODE=live`.
   */
  BINANCE_PRIVATE_WS_ENABLED: boolFromString(false),

  /**
   * Binance USD-M **WebSocket trading API** (`ws-fapi`) — session.logon / order.place (Ed25519).
   * Separate from public `fstream` market streams. Does not replace CoinDCX execution unless you wire it yourself.
   * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-api-general-info
   */
  BINANCE_FAPI_WS_ENABLED: boolFromString(false),
  BINANCE_FAPI_API_KEY: z.string().default(''),
  /** PEM file path for Binance API Ed25519 private key (PKCS#8). */
  BINANCE_FAPI_ED25519_PRIVATE_KEY_PATH: z.string().default(''),
  BINANCE_FAPI_WS_URL: z.string().url().optional(),
  BINANCE_FAPI_WS_REQUEST_TIMEOUT_MS: numFromString(30_000),
  /** When true, handshake uses `?returnRateLimits=false`. */
  BINANCE_FAPI_WS_HIDE_RATELIMITS: boolFromString(false),

  SHUTDOWN_TIMEOUT_MS: numFromString(5000),
  SHUTDOWN_FORCE_EXIT_MS: numFromString(10000),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export function applyTradingAssetPreset(cfg: AppConfig): AppConfig {
  if (cfg.TRADING_ASSET === 'custom') return cfg;
  const p = TRADING_ASSET_PRESETS[cfg.TRADING_ASSET];
  return {
    ...cfg,
    BINANCE_SYMBOL: p.binanceSymbol,
    COINDCX_PAIR: p.coindcxPair,
  };
}

export function loadConfig(): AppConfig {
  const parsed = AppConfigSchema.parse(process.env);
  return applyTradingAssetPreset(parsed);
}

/** USD-M REST per https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info */
export function binanceRestBase(cfg: AppConfig): string {
  if (cfg.BINANCE_REST_BASE) return cfg.BINANCE_REST_BASE;
  if (cfg.BINANCE_PRODUCT === 'spot') return 'https://api.binance.com';
  if (cfg.BINANCE_FUTURES_TESTNET) return 'https://testnet.binancefuture.com';
  return 'https://fapi.binance.com';
}

/**
 * Stream host root (no `/market` or `/public` suffix). For USD-M, multiplex builds
 * `…/market/stream` vs `…/public/stream` per Binance routed WebSocket docs.
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams
 */
export function binanceWsBase(cfg: AppConfig): string {
  if (cfg.BINANCE_WS_BASE) return cfg.BINANCE_WS_BASE;
  if (cfg.BINANCE_PRODUCT === 'spot') return 'wss://stream.binance.com:9443';
  if (cfg.BINANCE_FUTURES_TESTNET) return 'wss://fstream.binancefuture.com';
  return 'wss://fstream.binance.com';
}
