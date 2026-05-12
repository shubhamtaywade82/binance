import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PositionManager } from '../src/strategy/position-manager';
import { RiskManager } from '../src/strategy/risk';
import type { AppConfig } from '../src/config';
import { createStubExecutionAdapter } from './stub-execution-adapter';

const makeCfg = (over: Partial<AppConfig> = {}): AppConfig => {
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
    LTP_CONNECT_WARN_SEC: 15,
    LEVERAGE: 10,
    CAPITAL_PER_TRADE: 20000,
    CAPITAL_PER_TRADE_INR: 20000,
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
  } as AppConfig;
}

const noopLog = { info: () => undefined, warn: () => undefined };

let tmpCsv = '';

beforeEach(() => {
  tmpCsv = path.join(os.tmpdir(), `trades-${Date.now()}-${Math.random()}.csv`);
});

afterEach(() => {
  if (fs.existsSync(tmpCsv)) fs.unlinkSync(tmpCsv);
});

const buildPm = (over: Partial<AppConfig> = {}): PositionManager => {
  const cfg = makeCfg({ TRADE_LOG_PATH: tmpCsv, TRADES_CSV_PATH: tmpCsv, ...over });
  return new PositionManager(cfg, createStubExecutionAdapter(), new RiskManager(cfg), noopLog);
}

describe('PositionManager paper mode', () => {
  it('does not call the adapter when PLACE_ORDER is false', async () => {
    const adapter = createStubExecutionAdapter();
    const spy = vi.spyOn(adapter, 'placeOrder');
    const cfg = makeCfg({ PLACE_ORDER: false, TRADE_LOG_PATH: tmpCsv, TRADES_CSV_PATH: tmpCsv });
    const pm = new PositionManager(cfg, adapter, new RiskManager(cfg), noopLog);
    await pm.open('LONG', 100, { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }, 'B-SOL_USDT');
    expect(spy).not.toHaveBeenCalled();
    expect(pm.hasPosition()).toBe(false);
  });

  it('opens then closes on TP', async () => {
    const pm = buildPm();
    const pos = await pm.open('LONG', 100, { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }, 'B-SOL_USDT');
    expect(pos).not.toBeNull();
    expect(pm.hasPosition()).toBe(true);
    const evt = await pm.onMark(101.6, 'LONG');
    expect(evt?.reason).toBe('TP');
    expect(pm.hasPosition()).toBe(false);
    expect(fs.existsSync(tmpCsv)).toBe(true);
  });

  it('closes on SL', async () => {
    const pm = buildPm();
    await pm.open('LONG', 100, { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }, 'B-SOL_USDT');
    const evt = await pm.onMark(98.9, 'LONG');
    expect(evt?.reason).toBe('SL');
  });

  it('closes on HTF reversal', async () => {
    const pm = buildPm();
    await pm.open('LONG', 100, { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }, 'B-SOL_USDT');
    const evt = await pm.onMark(100.2, 'SHORT');
    expect(evt?.reason).toBe('REVERSAL');
  });

  it('does nothing without position', async () => {
    const pm = buildPm();
    const evt = await pm.onMark(100, 'LONG');
    expect(evt).toBeNull();
  });

  it('short TP at lower price', async () => {
    const pm = buildPm();
    await pm.open('SHORT', 100, { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }, 'B-SOL_USDT');
    const evt = await pm.onMark(98.4, 'SHORT');
    expect(evt?.reason).toBe('TP');
  });
});
