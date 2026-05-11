import { describe, expect, it, vi } from 'vitest';
import { HybridOrchestrator } from '../src/orchestrator';
import type { AppConfig } from '../src/config';
import type { Candle } from '../src/types';
import { BookTickerFeed } from '../src/execution/paper/book-ticker-feed';
import type { ExecutionRuntime } from '../src/execution/create-runtime';
import { createStubExecutionAdapter } from './stub-execution-adapter';

function makeCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    TRADING_ASSET: 'sol',
    BINANCE_PRODUCT: 'usdm',
    BINANCE_SYMBOL: 'SOLUSDT',
    BINANCE_KLINE_INTERVAL: '15m',
    BINANCE_HTF_INTERVAL: '1h',
    COINDCX_API_KEY: '',
    COINDCX_API_SECRET: '',
    API_BASE_URL: 'https://api.coindcx.com',
    PUBLIC_BASE_URL: 'https://public.coindcx.com',
    COINDCX_PAIR: 'B-SOL_USDT',
    READ_ONLY: true,
    PLACE_ORDER: true,
    LOG_HEARTBEAT_SEC: 60,
    LTP_CONNECT_WARN_SEC: 0,
    LEVERAGE: 10,
    CAPITAL_PER_TRADE: 20000,
    CAPITAL_PER_TRADE_INR: 20000,
    INR_PER_USDT: 85,
    TARGET_PNL_PCT: 0.10,
    STOP_LOSS_PCT: 0.05,
    TP_PRICE_PCT: 0.015,
    SL_PRICE_PCT: 0.01,
    MIN_CONFIDENCE: 0.4,
    MIN_SMC_SCORE: 0,
    TAKER_FEE: 0.0005,
    MAKER_FEE: 0.0002,
    FUNDING_FEE_EST: 0.0001,
    MARGIN_CURRENCY: 'USDT',
    USE_SMC: false,
    TRADES_CSV_PATH: '/tmp/orch-trades.csv',
    TRADE_LOG_PATH: '/tmp/orch-trades.csv',
    APP_LOG_PATH: '',
    EXECUTION_MODE: 'paper',
    PAPER_INITIAL_BALANCE_USDT: 10_000,
    PAPER_MAINT_MARGIN: 0.005,
    PAPER_BASE_SLIPPAGE_BPS: 2,
    PAPER_LATENCY_MS: 0,
    PAPER_LEDGER_DIR: '/tmp/orch-paper',
    PAPER_FUNDING_POLL_SEC: 300,
    PAPER_EQUITY_SNAPSHOT_SEC: 5,
    USDM_MARK_REST_POLL_SEC: 0,
    USE_SOL_MTF_STRATEGY: false,
    USE_SMC_CONFLUENCE: false,
    SMC_CONFLUENCE_MODE: 'standard',
    SMC_CONFLUENCE_MIN_STANDARD: 3,
    SMC_CONFLUENCE_MIN_SNIPER: 4,
    SMC_CONFLUENCE_TARGET_PCT: 0.015,
    BINANCE_TIMEFRAMES: ['15m', '1h'],
    BINANCE_HISTORY_BARS: 500,
    BINANCE_DEPTH_LEVELS: 0 as 0 | 5 | 10 | 20,
    BINANCE_DEPTH_SPEED: '100ms',
    BINANCE_USE_AGGTRADE: true,
    BINANCE_USE_BOOKTICKER: true,
    BINANCE_USE_MARK_PRICE: true,
    BINANCE_WS_RECONNECT_HOURS: 23,
    BINANCE_FUTURES_TESTNET: false,
    BINANCE_FAPI_WS_ENABLED: false,
    BINANCE_FAPI_API_KEY: '',
    BINANCE_FAPI_ED25519_PRIVATE_KEY_PATH: '',
    BINANCE_FAPI_WS_REQUEST_TIMEOUT_MS: 30_000,
    BINANCE_FAPI_WS_HIDE_RATELIMITS: false,
    SHUTDOWN_TIMEOUT_MS: 5000,
    SHUTDOWN_FORCE_EXIT_MS: 10000,
    ...over,
  } as AppConfig;
}

function stubRuntime(cfg: AppConfig): ExecutionRuntime {
  const book = new BookTickerFeed({
    wsBase: 'wss://fstream.binance.com',
    symbols: [cfg.BINANCE_SYMBOL.toUpperCase()],
  });
  vi.spyOn(book, 'stop').mockImplementation(() => {
    /* Avoid ws.close() throwing when the socket never connected (Vitest teardown). */
  });
  return { adapter: createStubExecutionAdapter(), book };
}

const noopLog = { info: () => undefined, warn: () => undefined };

function trendingCandles(n: number, start = 100, step = 0.5): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + i * step + Math.sin(i / 2) * 0.1;
    return {
      openTime: i * 60_000,
      open: i === 0 ? close : close - step,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: i === n - 1 ? 200 : 100,
    };
  });
}

function fakeWs() {
  return { start: vi.fn(), stop: vi.fn() } as unknown as import('../src/binance/ws-streams').BinanceMarketWs;
}

function fakeCdcx() {
  return {
    getFuturesInstrumentDetails: vi.fn().mockResolvedValue({}),
    createFuturesOrder: vi.fn(),
    cancelFuturesOrder: vi.fn(),
    getFuturesPositionByPair: vi.fn(),
    getFuturesPositions: vi.fn(),
    exitFuturesPosition: vi.fn(),
    createFuturesTpSlOrders: vi.fn(),
    updatePositionLeverage: vi.fn(),
  } as unknown as import('../src/coindcx/futures-client').CoinDcxFuturesClient;
}

describe('HybridOrchestrator entry gating', () => {
  it('throws when USE_SOL_MTF_STRATEGY is set but a required timeframe is missing', () => {
    const badCfg = makeCfg({
      USE_SOL_MTF_STRATEGY: true,
      BINANCE_TIMEFRAMES: ['5m', '15m'],
    });
    expect(
      () =>
        new HybridOrchestrator(badCfg, noopLog, {
          cdcx: fakeCdcx(),
          ws: fakeWs(),
          seedKlines: vi.fn().mockResolvedValue([]),
          execution: stubRuntime(badCfg),
        }),
    ).toThrow(/USE_SOL_MTF_STRATEGY requires/);
  });

  it('does not open a position when PLACE_ORDER is false', async () => {
    const cfg = makeCfg({ PLACE_ORDER: false });
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
      execution: stubRuntime(cfg),
    });
    const c = trendingCandles(80);
    orch.injectCandles(c, c);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(c[c.length - 1]);
    expect(orch.hasPosition()).toBe(false);
  });

  it('opens position when HTF and LTF both LONG with confidence and SMC pass', async () => {
    const cfg = makeCfg();
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
      execution: stubRuntime(cfg),
    });
    const c = trendingCandles(80);
    orch.injectCandles(c, c);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(c[c.length - 1]);
    expect(orch.hasPosition()).toBe(true);
  });

  it('skips entry when HTF and LTF disagree', async () => {
    const cfg = makeCfg();
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
      execution: stubRuntime(cfg),
    });
    const up = trendingCandles(80);
    const down = trendingCandles(80, 200, -0.5);
    orch.injectCandles(up, down);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(up[up.length - 1]);
    expect(orch.hasPosition()).toBe(false);
  });

  it('skips entry when confidence below minimum', async () => {
    const cfg = makeCfg({ MIN_CONFIDENCE: 0.99 });
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
      execution: stubRuntime(cfg),
    });
    const c = trendingCandles(80);
    orch.injectCandles(c, c);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(c[c.length - 1]);
    expect(orch.hasPosition()).toBe(false);
  });

  it('paper mode does not place CoinDCX order on entry', async () => {
    const cfg = makeCfg();
    const cdcx = fakeCdcx();
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx,
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
      execution: stubRuntime(cfg),
    });
    const c = trendingCandles(80);
    orch.injectCandles(c, c);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(c[c.length - 1]);
    expect(cdcx.createFuturesOrder).not.toHaveBeenCalled();
    expect(cdcx.exitFuturesPosition).not.toHaveBeenCalled();
  });

  it('live mode requires READ_ONLY=false and API keys', () => {
    expect(() =>
      new HybridOrchestrator(makeCfg({ EXECUTION_MODE: 'live', READ_ONLY: true }), noopLog, {
        cdcx: fakeCdcx(),
        ws: fakeWs(),
        seedKlines: vi.fn().mockResolvedValue([]),
      }),
    ).toThrow(/READ_ONLY=true/);

    expect(() =>
      new HybridOrchestrator(
        makeCfg({ EXECUTION_MODE: 'live', READ_ONLY: false, COINDCX_API_KEY: '', COINDCX_API_SECRET: '' }),
        noopLog,
        {
          cdcx: fakeCdcx(),
          ws: fakeWs(),
          seedKlines: vi.fn().mockResolvedValue([]),
        },
      ),
    ).toThrow(/COINDCX_API_KEY/);
  });

  it('skips entry when SMC required but score insufficient', async () => {
    const cfg = makeCfg({ USE_SMC: true, MIN_SMC_SCORE: 99 });
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
      execution: stubRuntime(cfg),
    });
    const c = trendingCandles(80);
    orch.injectCandles(c, c);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(c[c.length - 1]);
    expect(orch.hasPosition()).toBe(false);
  });

  it('confirms LTP from USD-M REST mark poll when WebSocket sends no mark', async () => {
    const cfg = makeCfg({ USDM_MARK_REST_POLL_SEC: 60 });
    const info = vi.fn();
    const fetchUsdmMarkRest = vi.fn().mockResolvedValue({ markPrice: 100.25, eventTime: 999 });
    const orch = new HybridOrchestrator(cfg, { info, warn: vi.fn() }, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
      execution: stubRuntime(cfg),
      fetchUsdmMarkRest,
    });
    await orch.start();
    await vi.waitUntil(() => fetchUsdmMarkRest.mock.calls.length > 0);
    await vi.waitUntil(() => info.mock.calls.some((c) => c[0] === 'ltp_connected'));
    expect(info).toHaveBeenCalledWith(
      'ltp_connected',
      expect.objectContaining({ source: 'mark_rest', price: 100.25 }),
    );
    orch.stop();
  });
});
