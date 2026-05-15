import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createAppLogger } from '../src/logging/app-logger';
import type { AppConfig } from '../src/config';

const cfgWithLog = (file: string): AppConfig => {
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
    PLACE_ORDER: false,
    LOG_HEARTBEAT_SEC: 60,
    LTP_CONNECT_WARN_SEC: 0,
    LEVERAGE: 10,
    CAPITAL_PER_TRADE: 20000,
    CAPITAL_PER_TRADE_INR: 20000,
    INR_PER_USDT: 85,
    TARGET_PNL_PCT: 0.1,
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
    APP_LOG_PATH: file,
    LOG_JSON_CONSOLE: false,
    EXECUTION_MODE: 'paper',
    PAPER_INITIAL_BALANCE_USDT: 10_000,
    PAPER_MAINT_MARGIN: 0.005,
    PAPER_BASE_SLIPPAGE_BPS: 2,
    PAPER_LATENCY_MS: 0,
    PAPER_LEDGER_DIR: './paper',
    PAPER_FUNDING_POLL_SEC: 300,
    PAPER_EQUITY_SNAPSHOT_SEC: 5,
    USDM_MARK_REST_POLL_SEC: 0,
  } as AppConfig;
}

describe('createAppLogger', () => {
  let tmp: string;

  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  });

  it('writes NDJSON lines when APP_LOG_PATH is set', () => {
    tmp = path.join(os.tmpdir(), `app-${Date.now()}.ndjson`);
    const log = createAppLogger(cfgWithLog(tmp));
    log.info('test_event', { x: 1 });
    const raw = fs.readFileSync(tmp, 'utf8').trim();
    const row = JSON.parse(raw) as { level: string; msg: string; x: number };
    expect(row.level).toBe('info');
    expect(row.msg).toBe('test_event');
    expect(row.x).toBe(1);
  });

  it('writes NDJSON to stdout when LOG_JSON_CONSOLE is true', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    tmp = path.join(os.tmpdir(), `app-json-${Date.now()}.ndjson`);
    const log = createAppLogger({ ...cfgWithLog(tmp), LOG_JSON_CONSOLE: true } as AppConfig);
    log.info('json_console_event', { n: 2 });
    expect(spy).toHaveBeenCalled();
    const written = String(spy.mock.calls[0][0]);
    const row = JSON.parse(written.trim()) as { level: string; msg: string; n: number };
    expect(row.level).toBe('info');
    expect(row.msg).toBe('json_console_event');
    expect(row.n).toBe(2);
    spy.mockRestore();
  });
});
