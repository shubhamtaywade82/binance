import { describe, expect, it } from 'vitest';
import { RiskManager } from '../src/strategy/risk';
import type { AppConfig } from '../src/config';

function cfg(over: Partial<AppConfig> = {}): AppConfig {
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
    LTP_CONNECT_WARN_SEC: 15,
    LEVERAGE: 10,
    CAPITAL_PER_TRADE: 20000,
    CAPITAL_PER_TRADE_INR: 20000,
    INR_PER_USDT: 85,
    TARGET_PNL_PCT: 0.10,
    STOP_LOSS_PCT: 0.05,
    MIN_CONFIDENCE: 0.65,
    MIN_SMC_SCORE: 2,
    TAKER_FEE: 0.0005,
    MAKER_FEE: 0.0002,
    FUNDING_FEE_EST: 0.0001,
    MARGIN_CURRENCY: 'USDT',
    USE_SMC: true,
    TRADES_CSV_PATH: './logs/trades.csv',
    TRADE_LOG_PATH: './logs/trades.csv',
    ...over,
  } as AppConfig;
}

describe('RiskManager.sizePosition', () => {
  it('computes margin/notional/qty', () => {
    const rm = new RiskManager(cfg());
    const r = rm.sizePosition(200, 0.001);
    expect(r.marginInr).toBe(20000);
    expect(r.marginUsdt).toBeCloseTo(20000 / 85, 5);
    expect(r.notionalUsdt).toBeCloseTo((20000 / 85) * 10, 5);
    expect(r.quantity).toBeGreaterThan(0);
  });

  it('returns zero qty for invalid price', () => {
    const rm = new RiskManager(cfg());
    expect(rm.sizePosition(0).quantity).toBe(0);
  });
});

describe('RiskManager.targets', () => {
  it('1% price move = 10% PnL at 10x leverage (long)', () => {
    const rm = new RiskManager(cfg());
    const t = rm.targets(100, 'LONG');
    expect(t.takeProfit).toBeCloseTo(101, 6);
    expect(t.stopLoss).toBeCloseTo(99.5, 6);
  });

  it('inverts for short', () => {
    const rm = new RiskManager(cfg());
    const t = rm.targets(100, 'SHORT');
    expect(t.takeProfit).toBeCloseTo(99, 6);
    expect(t.stopLoss).toBeCloseTo(100.5, 6);
  });
});

describe('RiskManager.netPnl', () => {
  it('subtracts fees and converts to INR', () => {
    const rm = new RiskManager(cfg());
    const r = rm.netPnl(100, 101, 'LONG', 10);
    expect(r.grossUsdt).toBeCloseTo(10, 5);
    expect(r.feesUsdt).toBeGreaterThan(0);
    expect(r.netUsdt).toBeLessThan(r.grossUsdt);
    expect(r.netInr).toBeCloseTo(r.netUsdt * 85, 5);
  });

  it('negative for losing short', () => {
    const rm = new RiskManager(cfg());
    const r = rm.netPnl(100, 105, 'SHORT', 10);
    expect(r.grossUsdt).toBeCloseTo(-50, 5);
    expect(r.netUsdt).toBeLessThan(0);
  });
});
