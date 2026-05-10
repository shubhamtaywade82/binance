import { describe, expect, it, vi } from 'vitest';
import { HybridOrchestrator } from '../src/orchestrator';
import type { AppConfig } from '../src/config';
import type { Candle } from '../src/types';

function makeCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
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
    EXECUTION_ENABLED: false,
    LOG_HEARTBEAT_SEC: 60,
    LTP_CONNECT_WARN_SEC: 0,
    LEVERAGE: 10,
    CAPITAL_PER_TRADE: 20000,
    CAPITAL_PER_TRADE_INR: 20000,
    INR_PER_USDT: 85,
    TARGET_PNL_PCT: 0.10,
    STOP_LOSS_PCT: 0.05,
    MIN_CONFIDENCE: 0.4,
    MIN_SMC_SCORE: 0,
    TAKER_FEE: 0.0005,
    MAKER_FEE: 0.0002,
    FUNDING_FEE_EST: 0.0001,
    MARGIN_CURRENCY: 'USDT',
    USE_SMC: false,
    TRADES_CSV_PATH: '/tmp/orch-trades.csv',
    TRADE_LOG_PATH: '/tmp/orch-trades.csv',
    ...over,
  } as AppConfig;
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
  it('opens position when HTF and LTF both LONG with confidence and SMC pass', async () => {
    const cfg = makeCfg();
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
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
    });
    const c = trendingCandles(80);
    orch.injectCandles(c, c);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(c[c.length - 1]);
    expect(orch.hasPosition()).toBe(false);
  });

  it('skips entry when SMC required but score insufficient', async () => {
    const cfg = makeCfg({ USE_SMC: true, MIN_SMC_SCORE: 99 });
    const orch = new HybridOrchestrator(cfg, noopLog, {
      cdcx: fakeCdcx(),
      ws: fakeWs(),
      seedKlines: vi.fn().mockResolvedValue([]),
    });
    const c = trendingCandles(80);
    orch.injectCandles(c, c);
    orch.setPrecision({ tickSize: 0.01, stepSize: 0.001, minQty: 0.001 });
    await orch.evaluateBar(c[c.length - 1]);
    expect(orch.hasPosition()).toBe(false);
  });
});
