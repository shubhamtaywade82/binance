import { describe, expect, it } from 'vitest';
import { RiskManager } from '../src/strategy/risk';
import type { AppConfig } from '../src/config';

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({
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
  PLACE_ORDER: false,
  LOG_HEARTBEAT_SEC: 60,
  LTP_CONNECT_WARN_SEC: 0,
  LEVERAGE: 10,
  MAX_NOTIONAL_USDT: 0,
  CAPITAL_PER_TRADE: 20000,
  CAPITAL_PER_TRADE_INR: 20000,
  CAPITAL_PER_TRADE_USDT: 0,
  INR_PER_USDT: 85,
  TARGET_PNL_PCT: 0.10,
  STOP_LOSS_PCT: 0.05,
  TP_PRICE_PCT: 0.015,
  SL_PRICE_PCT: 0.01,
  MIN_CONFIDENCE: 0.65,
  MIN_SMC_SCORE: 2,
  TAKER_FEE: 0.0005,
  MAKER_FEE: 0.0002,
  FUNDING_FEE_EST: 0.0001,
  MARGIN_CURRENCY: 'USDT',
  USE_SMC: true,
  TRADES_CSV_PATH: './logs/trades.csv',
  TRADE_LOG_PATH: './logs/trades.csv',
  APP_LOG_PATH: '',
  EXECUTION_MODE: 'paper',
  PAPER_INITIAL_BALANCE_USDT: 10_000,
  PAPER_MAINT_MARGIN: 0.005,
  PAPER_BASE_SLIPPAGE_BPS: 2,
  PAPER_LATENCY_MS: 0,
  PAPER_LEDGER_DIR: './paper',
  PAPER_FUNDING_POLL_SEC: 300,
  PAPER_EQUITY_SNAPSHOT_SEC: 5,
  USDM_MARK_REST_POLL_SEC: 0,
  ...over,
} as AppConfig);

describe('RiskManager.sizePosition with tier overrides', () => {
  it('uses marginUsdt + leverage override over cfg values', () => {
    const rm = new RiskManager(cfg({ CAPITAL_PER_TRADE_USDT: 1000, LEVERAGE: 10 }));
    const r = rm.sizePosition(100, 0.001, { marginUsdt: 500, leverage: 3 });
    expect(r.marginUsdt).toBe(500);
    expect(r.notionalUsdt).toBeCloseTo(1500, 6);
    expect(r.quantity).toBeCloseTo(15, 5);
  });

  it('partial override (only leverage) keeps cfg margin', () => {
    const rm = new RiskManager(cfg({ CAPITAL_PER_TRADE_USDT: 1000, LEVERAGE: 10 }));
    const r = rm.sizePosition(100, 0.001, { leverage: 4 });
    expect(r.marginUsdt).toBe(1000);
    expect(r.notionalUsdt).toBeCloseTo(4000, 6);
  });

  it('still accepts the legacy 3rd-positional realizedVol argument', () => {
    const rm = new RiskManager(cfg({
      CAPITAL_PER_TRADE_USDT: 1000, LEVERAGE: 10,
      VOL_ADJUSTED_SIZING: true, VOL_BASELINE: 0.01,
    }));
    // realizedVol > baseline → margin scales down by ratio (clamped >= 0.5).
    const r = rm.sizePosition(100, 0.001, 0.05);
    expect(r.marginUsdt).toBeLessThan(1000);
    expect(r.marginUsdt).toBeGreaterThanOrEqual(500);
  });
});

describe('RiskManager.targets with tier overrides', () => {
  it('overrides tpPct/slPct for the call', () => {
    const rm = new RiskManager(cfg());
    const t = rm.targets(100, 'LONG', { tpPct: 0.02, slPct: 0.012 });
    expect(t.takeProfit).toBeCloseTo(102, 6);
    expect(t.stopLoss).toBeCloseTo(98.8, 6);
  });

  it('inverts for short with overrides', () => {
    const rm = new RiskManager(cfg());
    const t = rm.targets(100, 'SHORT', { tpPct: 0.025, slPct: 0.015 });
    expect(t.takeProfit).toBeCloseTo(97.5, 6);
    expect(t.stopLoss).toBeCloseTo(101.5, 6);
  });

  it('without opts uses cfg defaults (backward compatible)', () => {
    const rm = new RiskManager(cfg());
    const t = rm.targets(100, 'LONG');
    expect(t.takeProfit).toBeCloseTo(101.5, 6);
    expect(t.stopLoss).toBeCloseTo(99, 6);
  });
});
