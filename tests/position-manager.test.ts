import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PositionManager } from '../src/strategy/position-manager';
import { RiskManager } from '../src/strategy/risk';
import { CoinDcxFuturesClient } from '../src/coindcx/futures-client';
import type { AppConfig } from '../src/config';

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

const noopLog = { info: () => undefined, warn: () => undefined };

let tmpCsv = '';

beforeEach(() => {
  tmpCsv = path.join(os.tmpdir(), `trades-${Date.now()}-${Math.random()}.csv`);
});

afterEach(() => {
  if (fs.existsSync(tmpCsv)) fs.unlinkSync(tmpCsv);
});

function buildPm(over: Partial<AppConfig> = {}): PositionManager {
  const cfg = makeCfg({ TRADE_LOG_PATH: tmpCsv, TRADES_CSV_PATH: tmpCsv, ...over });
  const cdcx = new CoinDcxFuturesClient({
    apiKey: '', apiSecret: '', apiBaseUrl: cfg.API_BASE_URL, readOnly: true,
  });
  return new PositionManager(cfg, cdcx, new RiskManager(cfg), noopLog);
}

describe('PositionManager paper mode', () => {
  it('opens then closes on TP', async () => {
    const pm = buildPm();
    const pos = await pm.open('LONG', 100, { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }, 'B-SOL_USDT');
    expect(pos).not.toBeNull();
    expect(pm.hasPosition()).toBe(true);
    const evt = await pm.onMark(101.1, 'LONG');
    expect(evt?.reason).toBe('TP');
    expect(pm.hasPosition()).toBe(false);
    expect(fs.existsSync(tmpCsv)).toBe(true);
  });

  it('closes on SL', async () => {
    const pm = buildPm();
    await pm.open('LONG', 100, { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 }, 'B-SOL_USDT');
    const evt = await pm.onMark(99.4, 'LONG');
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
    const evt = await pm.onMark(98.9, 'SHORT');
    expect(evt?.reason).toBe('TP');
  });
});
