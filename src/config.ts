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

/** Treat empty string as unset so `KEY=` lines work in `.env`. */
const emptyToUndefined = (v: unknown): unknown =>
  v === '' || v === undefined || v === null ? undefined : v;

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
  BINANCE_REST_BASE: z.preprocess(emptyToUndefined, z.string().url().optional()),
  BINANCE_WS_BASE: z.preprocess(emptyToUndefined, z.string().url().optional()),
  BINANCE_SYMBOL: z.string().min(1).default('SOLUSDT'),
  /**
   * Extra Binance USD-M symbols (comma-separated) for the shared multiplex feed + dashboard watchlist.
   * `BINANCE_SYMBOL` remains the execution / strategy primary and is always subscribed first.
   * Example: `ETHUSDT,BTCUSDT` with primary SOLUSDT → SOL + ETH + BTC on one stream.
   */
  BINANCE_WATCHLIST: z
    .string()
    .default('')
    .transform((s) =>
      [...new Set(s.split(',').map((p) => p.trim().toUpperCase()).filter((p) => p.length > 0))],
    ),
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
  /**
   * USDT margin per trade for Binance USDT-M Futures (preferred).
   * When set to a positive value, overrides the INR-based sizing path.
   * Example: 200 USDT margin × 10× leverage = 2000 USDT notional.
   */
  CAPITAL_PER_TRADE_USDT: numFromString(0),
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
   * Multi-timeframe SMC stack (5m execution close, 15m/1h/4h/1d filters; optional 1m for finer chart/stream).
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
    .default('5m,15m,1m,1h,4h,1d')
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
  /** Stream per-symbol liquidation orders (`@forceOrder`) for SMC liquidity sweep detection. USD-M only. */
  BINANCE_USE_FORCE_ORDER: boolFromString(false),
  /** Stream ALL-symbol liquidation events (`!forceOrder@arr`). Useful for cascade detection. USD-M only. */
  BINANCE_USE_GLOBAL_FORCE_ORDER: boolFromString(false),
  BINANCE_WS_RECONNECT_HOURS: numFromString(23),

  /**
   * Binance REST (`BinanceRestClient`): max HTTP attempts per call on 408/429/5xx and transport failures.
   * 1 = no retries. Capped at 12.
   */
  BINANCE_REST_RETRY_MAX_ATTEMPTS: z
    .string()
    .optional()
    .default('4')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 1) return 4;
      return Math.min(12, n);
    }),
  /** Initial backoff cap (ms) before exponential growth; combined with full jitter. */
  BINANCE_REST_RETRY_BASE_MS: z
    .string()
    .optional()
    .default('400')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 50) return 400;
      return Math.min(10_000, n);
    }),
  /** Upper bound (ms) on each wait, including when honoring `Retry-After`. */
  BINANCE_REST_RETRY_MAX_MS: z
    .string()
    .optional()
    .default('20000')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 100) return 20_000;
      return Math.min(120_000, n);
    }),

  /**
   * USD-M Futures **testnet** (derivatives demo): REST `demo-fapi.binance.com`, WS `fstream.binancefuture.com`.
   * Ignored when `BINANCE_PRODUCT=spot`. Overrides ignored if `BINANCE_REST_BASE` / `BINANCE_WS_BASE` are set.
   * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
   */
  BINANCE_FUTURES_TESTNET: boolFromString(false),

  /**
   * Binance HMAC-SHA256 REST trading credentials — **mainnet**.
   * Required when `BINANCE_EXECUTION_ADAPTER=true` and `BINANCE_FUTURES_TESTNET=false`.
   * Enable Futures trading on the API key and restrict by IP before going live.
   */
  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),

  /**
   * Binance HMAC-SHA256 REST trading credentials — **testnet**.
   * Required when `BINANCE_EXECUTION_ADAPTER=true` and `BINANCE_FUTURES_TESTNET=true`.
   * Generate at https://testnet.binancefuture.com — these keys are completely separate
   * from mainnet keys and will produce -2015 errors if used against mainnet endpoints.
   */
  BINANCE_TESTNET_API_KEY: z.string().default(''),
  BINANCE_TESTNET_API_SECRET: z.string().default(''),

  /**
   * Safety interlock for mainnet live trading.
   * Must be set to `true` (or `"true"`) when `EXECUTION_MODE=live`,
   * `BINANCE_EXECUTION_ADAPTER=true`, and `BINANCE_FUTURES_TESTNET=false`.
   * Prevents accidental real-money orders during development.
   */
  CONFIRMED_LIVE_TRADING: boolFromString(false),

  /**
   * When true, live execution uses Binance FAPI directly (HMAC REST + private WS) instead of CoinDCX.
   * Requires matching API keys, `EXECUTION_MODE=live`, `READ_ONLY=false`.
   * For mainnet also requires `CONFIRMED_LIVE_TRADING=true`.
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
  BINANCE_FAPI_WS_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  BINANCE_FAPI_WS_REQUEST_TIMEOUT_MS: numFromString(30_000),
  /** When true, handshake uses `?returnRateLimits=false`. */
  BINANCE_FAPI_WS_HIDE_RATELIMITS: boolFromString(false),

  /**
   * When true, `src/index.ts` serves the dashboard WebSocket on `DASHBOARD_BIND`:`DASHBOARD_PORT`
   * using the same multiplex-backed store/orderbook/trade tape as the orchestrator (no duplicate Binance WS).
   */
  DASHBOARD_ENABLED: boolFromString(false),
  /** Dashboard WebSocket listen port (browser UI connects here, e.g. via `npm run ui:dev`). */
  DASHBOARD_PORT: z
    .string()
    .default('4001')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 1 || n > 65535) return 4001;
      return n;
    }),
  /** Dashboard HTTP/WS bind address (`127.0.0.1` = local only; use `0.0.0.0` for LAN/Docker). */
  DASHBOARD_BIND: z.string().default('127.0.0.1'),
  /** In-memory kline cap per timeframe when the dashboard is enabled (larger = deeper chart history). */
  DASHBOARD_STORE_MAX_BARS: z
    .union([z.number(), z.string()])
    .default(100_000)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(String(v), 10)))
    .pipe(z.number().int().min(1000).max(500_000)),

  /**
   * Optional LLM narrative from structured signals via `ollama` JS → local Ollama or Ollama Cloud (dashboard UI).
   */
  AI_MARKET_BRIEF_ENABLED: boolFromString(false),
  /**
   * Which Ollama API base to use (URLs are fixed in code — see `ollamaApiUrl`).
   * `local` → `http://127.0.0.1:11434` · `cloud` → `https://ollama.com` (set `OLLAMA_API_KEY`).
   */
  OLLAMA_TARGET: z
    .union([z.enum(['local', 'cloud']), z.string()])
    .default('local')
    .transform((v) => {
      const s = String(v).trim().toLowerCase();
      return s === 'cloud' ? 'cloud' : 'local';
    })
    .pipe(z.enum(['local', 'cloud'])),
  /** Model name as known to Ollama (e.g. `llama3.2`, `mistral` — run `ollama pull <name>` locally). */
  OLLAMA_MODEL: z.string().default('llama3.2'),
  /** Bearer token for Ollama Cloud (required when `OLLAMA_TARGET=cloud`). */
  OLLAMA_API_KEY: z.string().default(''),
  /** Minimum seconds between LLM calls when signals refresh. */
  AI_BRIEF_INTERVAL_SEC: z
    .union([z.number(), z.string()])
    .default(120)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(String(v), 10)))
    .pipe(z.number().int().min(30).max(3600)),
  AI_REQUEST_TIMEOUT_MS: z
    .union([z.number(), z.string()])
    .default(60_000)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(String(v), 10)))
    .pipe(z.number().int().min(3000).max(120_000)),
  /**
   * When true (and dashboard enabled), periodically asks Ollama for SuperTrend `atrPeriod` + `multiplier`;
   * the chart still uses deterministic {@link supertrend} math with those parameters.
   */
  AI_SUPERTREND_TUNING_ENABLED: boolFromString(false),
  /** Minimum seconds between SuperTrend tuning Ollama calls per symbol. */
  AI_SUPERTREND_TUNING_INTERVAL_SEC: z
    .union([z.number(), z.string()])
    .default(300)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(String(v), 10)))
    .pipe(z.number().int().min(60).max(3600)),

  /**
   * Binance `POST /fapi/v1/countdownCancelAll` period (ms). Each tick renews the timer.
   * 0 = disabled. Example: `120000` = cancel all open orders if renewals stop for 2 minutes.
   */
  BINANCE_DEADMAN_COUNTDOWN_MS: z
    .string()
    .optional()
    .default('0')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 0) return 0;
      return Math.min(7 * 24 * 60 * 60 * 1000, n);
    }),

  /**
   * Halt new entries and cancel open orders when USDT wallet balance falls this fraction
   * below the session peak (0 = disabled). Peak is updated from `ACCOUNT_UPDATE` and startup `GET /fapi/v2/account`.
   */
  DAILY_DRAWDOWN_KILL_PCT: numFromString(0),

  /**
   * When > 0, pause new entries if `GET /fapi/v1/rateLimit/order` shows ORDER row `count/limit` ≥ this threshold (e.g. 0.92).
   */
  ORDER_RATE_LIMIT_PAUSE_THRESHOLD: numFromString(0),

  /** Max bid-ask spread in bps to allow entry (0 = disabled). Rejects entries in wide-spread conditions. */
  MAX_ENTRY_SPREAD_BPS: numFromString(0),

  /** Max concurrent open positions across all symbols (0 = unlimited). */
  MAX_OPEN_POSITIONS: numFromString(0),

  /** Scale position size inversely with realized volatility. */
  VOL_ADJUSTED_SIZING: boolFromString(false),
  /** Baseline realized volatility (annualized %). Position scales down when rv > baseline. */
  VOL_BASELINE: numFromString(0),

  /** UTC hours allowed for new entries (e.g. "02:00-21:00"). Empty = no restriction. */
  TRADING_HOURS_UTC: z.string().default(''),

  /** Entry order type: MARKET (default) or LIMIT_GTX (post-only maker fill at microprice). */
  ENTRY_ORDER_TYPE: z.string().default('MARKET'),
  /** Trailing stop callback rate (%). 0 = use fixed SL instead. */
  TRAILING_STOP_CALLBACK_RATE: numFromString(0),

  /** Enable ML inference pipeline (feature collection, inference client, ML gate). */
  ML_ENABLED: boolFromString(false),
  /** ML inference server URL (Python FastAPI). */
  ML_INFERENCE_URL: z.string().default('http://localhost:8000/infer'),
  /** Minimum model probability to act on a signal. */
  ML_MIN_PROBABILITY: numFromString(0.65),
  /** Minimum edge in bps after fees for ML to allow entry. */
  ML_MIN_EDGE_BPS: numFromString(8),
  /** When true, ML logs predictions but does not override SMC entry decisions. */
  ML_SHADOW_MODE: boolFromString(true),
  /** Inference timeout in ms. */
  ML_INFERENCE_TIMEOUT_MS: numFromString(2000),
  /** Directory for recorded feature vectors (training data). */
  ML_FEATURE_DIR: z.string().default('./data/features'),
  /** Directory for prediction logs. */
  ML_PREDICTION_DIR: z.string().default('./data/predictions'),

  SHUTDOWN_TIMEOUT_MS: numFromString(5000),
  SHUTDOWN_FORCE_EXIT_MS: numFromString(10000),

  /**
   * ioredis connection URL. When set, the bot publishes ticks, signals, and position events
   * to Redis pub/sub channels and writes position/balance state to Redis keys.
   * When absent (default), all Redis calls are silently skipped — the bot runs unchanged.
   * Example: `redis://localhost:6379`
   */
  REDIS_URL: z.preprocess(emptyToUndefined, z.string().optional()),

  /**
   * HTTP port for the runtime control plane (`/runtime/config`, `/runtime/status`,
   * `/runtime/kill`, `/runtime/unkill`). 0 = disabled. Default 4002.
   * Binds to 127.0.0.1 only — not exposed externally unless you reverse-proxy it.
   */
  CONTROL_PORT: z
    .string()
    .default('4002')
    .transform((s) => {
      const n = Number.parseInt(String(s).trim(), 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) return 4002;
      return n;
    }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const multiplexBinanceSymbols = (cfg: AppConfig): string[] => {
  const primary = cfg.BINANCE_SYMBOL.trim().toUpperCase();
  const wl = cfg.BINANCE_WATCHLIST ?? [];
  const extra = wl.filter((s) => s !== primary);
  return [primary, ...extra];
}

/** Ollama HTTP API base for `OLLAMA_TARGET=local` (fixed). */
export const OLLAMA_LOCAL_API_URL = 'http://127.0.0.1:11434' as const;
/** Ollama HTTP API base for `OLLAMA_TARGET=cloud` (fixed). @see https://github.com/ollama/ollama-js */
export const OLLAMA_CLOUD_API_URL = 'https://ollama.com' as const;

export type OllamaTarget = 'local' | 'cloud';

export const ollamaApiUrl = (target: OllamaTarget): string => {
  return target === 'cloud' ? OLLAMA_CLOUD_API_URL : OLLAMA_LOCAL_API_URL;
}

export const applyTradingAssetPreset = (cfg: AppConfig): AppConfig => {
  if (cfg.TRADING_ASSET === 'custom') return cfg;
  const p = TRADING_ASSET_PRESETS[cfg.TRADING_ASSET];
  return {
    ...cfg,
    BINANCE_SYMBOL: p.binanceSymbol,
    COINDCX_PAIR: p.coindcxPair,
  };
}

export const loadConfig = (): AppConfig => {
  const parsed = AppConfigSchema.parse(process.env);
  return applyTradingAssetPreset(parsed);
}

/**
 * Returns the correct HMAC API key and secret for the active environment.
 * Testnet and mainnet use completely separate key pairs — mixing them
 * produces a -2015 Invalid API-key error from Binance.
 */
export const binanceApiCredentials = (cfg: AppConfig): { apiKey: string; apiSecret: string } => {
  if (cfg.BINANCE_FUTURES_TESTNET) {
    return {
      apiKey: cfg.BINANCE_TESTNET_API_KEY.trim(),
      apiSecret: cfg.BINANCE_TESTNET_API_SECRET.trim(),
    };
  }
  return {
    apiKey: cfg.BINANCE_API_KEY.trim(),
    apiSecret: cfg.BINANCE_API_SECRET.trim(),
  };
}

export const binanceRestBase = (cfg: AppConfig): string => {
  if (cfg.BINANCE_REST_BASE) return cfg.BINANCE_REST_BASE;
  if (cfg.BINANCE_PRODUCT === 'spot') return 'https://api.binance.com';
  if (cfg.BINANCE_FUTURES_TESTNET) return 'https://testnet.binancefuture.com';
  return 'https://fapi.binance.com';
}

export const binanceWsBase = (cfg: AppConfig): string => {
  if (cfg.BINANCE_WS_BASE) return cfg.BINANCE_WS_BASE;
  if (cfg.BINANCE_PRODUCT === 'spot') return 'wss://stream.binance.com:9443';
  if (cfg.BINANCE_FUTURES_TESTNET) return 'wss://fstream.binancefuture.com';
  return 'wss://fstream.binance.com';
}
