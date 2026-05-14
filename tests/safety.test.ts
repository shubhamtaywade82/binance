import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config';
import { binanceRestBase, binanceWsBase } from '../src/config';
import { validateEnvironment } from '../src/safety/env-validator';
import { ShadowMode } from '../src/safety/shadow-mode';
import { ShadowPredictionLogger } from '../src/safety/shadow-prediction-log';
import { applyNotionalCap } from '../src/safety/notional-cap';
import type { ExecutionAdapter, OrderRequest } from '../src/execution/types';

const baseCfg = (overrides: Partial<AppConfig> = {}): AppConfig =>
  ({
    EXECUTION_MODE: 'paper',
    BINANCE_FUTURES_TESTNET: false,
    CONFIRMED_LIVE_TRADING: false,
    BINANCE_DEADMAN_COUNTDOWN_MS: 120_000,
    DAILY_DRAWDOWN_KILL_PCT: 0.03,
    MAX_OPEN_POSITIONS: 5,
    MAX_NOTIONAL_USDT: 10_000,
    SHADOW_MODE: false,
    BINANCE_PRODUCT: 'usdm',
    BINANCE_REST_BASE: undefined,
    BINANCE_WS_BASE: undefined,
    ...overrides,
  }) as unknown as AppConfig;

const mockLogger = () => ({ warn: vi.fn() });

// ── env-validator ──────────────────────────────────────────────────────────

describe('validateEnvironment', () => {
  it('throws when live + mainnet without CONFIRMED_LIVE_TRADING', () => {
    const logger = mockLogger();
    const cfg = baseCfg({ EXECUTION_MODE: 'live', CONFIRMED_LIVE_TRADING: false });
    expect(() => validateEnvironment(cfg, logger)).toThrow('CONFIRMED_LIVE_TRADING');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('does not throw when live + mainnet + CONFIRMED_LIVE_TRADING=true', () => {
    const logger = mockLogger();
    const cfg = baseCfg({
      EXECUTION_MODE: 'live',
      CONFIRMED_LIVE_TRADING: true,
    });
    expect(() => validateEnvironment(cfg, logger)).not.toThrow();
  });

  it('does not throw when live + testnet (no confirmation needed)', () => {
    const logger = mockLogger();
    const cfg = baseCfg({
      EXECUTION_MODE: 'live',
      BINANCE_FUTURES_TESTNET: true,
      CONFIRMED_LIVE_TRADING: false,
    });
    expect(() => validateEnvironment(cfg, logger)).not.toThrow();
  });

  it('warns about testnet fill unreliability', () => {
    const logger = mockLogger();
    const cfg = baseCfg({ BINANCE_FUTURES_TESTNET: true });
    validateEnvironment(cfg, logger);
    const calls = logger.warn.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((m: string) => m.includes('not realistic'))).toBe(true);
  });

  it('warns when live + no dead-man switch', () => {
    const logger = mockLogger();
    const cfg = baseCfg({
      EXECUTION_MODE: 'live',
      CONFIRMED_LIVE_TRADING: true,
      BINANCE_DEADMAN_COUNTDOWN_MS: 0,
    });
    validateEnvironment(cfg, logger);
    const calls = logger.warn.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((m: string) => m.includes('dead-man'))).toBe(true);
  });

  it('warns when live + no drawdown kill', () => {
    const logger = mockLogger();
    const cfg = baseCfg({
      EXECUTION_MODE: 'live',
      CONFIRMED_LIVE_TRADING: true,
      DAILY_DRAWDOWN_KILL_PCT: 0,
    });
    validateEnvironment(cfg, logger);
    const calls = logger.warn.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((m: string) => m.includes('drawdown'))).toBe(true);
  });

  it('warns when live + unlimited positions', () => {
    const logger = mockLogger();
    const cfg = baseCfg({
      EXECUTION_MODE: 'live',
      CONFIRMED_LIVE_TRADING: true,
      MAX_OPEN_POSITIONS: 0,
    });
    validateEnvironment(cfg, logger);
    const calls = logger.warn.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((m: string) => m.includes('MAX_OPEN_POSITIONS'))).toBe(true);
  });

  it('warns when live + no notional cap', () => {
    const logger = mockLogger();
    const cfg = baseCfg({
      EXECUTION_MODE: 'live',
      CONFIRMED_LIVE_TRADING: true,
      MAX_NOTIONAL_USDT: 0,
    });
    validateEnvironment(cfg, logger);
    const calls = logger.warn.mock.calls.map((c: string[]) => c[0]);
    expect(calls.some((m: string) => m.includes('MAX_NOTIONAL_USDT'))).toBe(true);
  });

  it('is silent on a safe paper config', () => {
    const logger = mockLogger();
    validateEnvironment(baseCfg(), logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ── shadow-mode ────────────────────────────────────────────────────────────

describe('ShadowMode', () => {
  const makeAdapter = (): ExecutionAdapter => ({
    name: 'paper',
    placeOrder: vi.fn().mockResolvedValue({ ok: true, orderId: 'real-1', fill: {} }),
    closePosition: vi.fn().mockResolvedValue({ orderId: 'real-1', reason: 'TP' }),
    onMark: vi.fn(),
    setLeverage: vi.fn().mockResolvedValue(undefined),
  });

  const sampleOrder: OrderRequest = {
    pair: 'B-SOL_USDT',
    side: 'LONG',
    quantity: 1,
    leverage: 10,
    marginCurrency: 'USDT',
    referencePrice: 150,
  };

  it('suppresses placeOrder and returns shadow orderId', async () => {
    const real = makeAdapter();
    const logger = mockLogger();
    const shadow = new ShadowMode(real, logger);

    const result = await shadow.placeOrder(sampleOrder);
    expect(result.ok).toBe(true);
    expect(result.orderId).toMatch(/^shadow-/);
    expect(real.placeOrder).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[SHADOW] placeOrder'),
      expect.objectContaining({ pair: 'B-SOL_USDT' }),
    );
  });

  it('suppresses closePosition', async () => {
    const real = makeAdapter();
    const logger = mockLogger();
    const shadow = new ShadowMode(real, logger);

    const result = await shadow.closePosition('ord-1', 'SL');
    expect(result.reason).toBe('SL');
    expect(real.closePosition).not.toHaveBeenCalled();
  });

  it('suppresses setLeverage', async () => {
    const real = makeAdapter();
    const logger = mockLogger();
    const shadow = new ShadowMode(real, logger);

    await shadow.setLeverage('SOLUSDT', 20);
    expect(real.setLeverage).not.toHaveBeenCalled();
  });

  it('passes onMark through to the real adapter', () => {
    const real = makeAdapter();
    const logger = mockLogger();
    const shadow = new ShadowMode(real, logger);

    shadow.onMark('SOLUSDT', 155);
    expect(real.onMark).toHaveBeenCalledWith('SOLUSDT', 155);
  });

  it('preserves the real adapter name', () => {
    const real = makeAdapter();
    const shadow = new ShadowMode(real, mockLogger());
    expect(shadow.name).toBe('paper');
  });
});

// ── notional-cap ───────────────────────────────────────────────────────────

describe('applyNotionalCap', () => {
  it('clamps qty when notional exceeds cap', () => {
    expect(applyNotionalCap(10, 200, 1000)).toBeCloseTo(5);
  });

  it('returns original qty when within cap', () => {
    expect(applyNotionalCap(2, 200, 1000)).toBe(2);
  });

  it('returns original qty when cap is disabled (0)', () => {
    expect(applyNotionalCap(100, 200, 0)).toBe(100);
  });

  it('returns original qty when cap is negative', () => {
    expect(applyNotionalCap(100, 200, -500)).toBe(100);
  });

  it('returns original qty when price is 0', () => {
    expect(applyNotionalCap(100, 0, 1000)).toBe(100);
  });

  it('returns original qty when price is negative', () => {
    expect(applyNotionalCap(100, -10, 1000)).toBe(100);
  });

  it('clamps to exact boundary when notional == cap', () => {
    expect(applyNotionalCap(5, 200, 1000)).toBe(5);
  });
});

// ── shadow-prediction-log ──────────────────────────────────────────────────

describe('ShadowPredictionLogger', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-pred-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a CSV with header on first signal', () => {
    const logger = new ShadowPredictionLogger(tmpDir);
    const id = logger.logSignal('SOLUSDT', 'LONG', 150.5, 0.82);

    expect(id).toBeGreaterThan(0);
    const content = fs.readFileSync(logger.filePath(), 'utf8');
    expect(content).toContain('prediction_id,timestamp,symbol');
    expect(content).toContain('SOLUSDT');
    expect(content).toContain('LONG');
    expect(content).toContain('150.5');
  });

  it('appends outcome rows', () => {
    const logger = new ShadowPredictionLogger(tmpDir);
    const id = logger.logSignal('ETHUSDT', 'SHORT', 3200, 0.71);
    logger.fillOutcome(id, 3150);

    const content = fs.readFileSync(logger.filePath(), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3); // header + signal + outcome
    expect(lines[2]).toContain('3150');
  });

  it('rotates file by day', () => {
    const logger = new ShadowPredictionLogger(tmpDir);
    logger.logSignal('SOLUSDT', 'LONG', 150, 0.8);
    const firstFile = logger.filePath();

    const tomorrow = Date.now() + 86_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(tomorrow);
    try {
      logger.logSignal('SOLUSDT', 'SHORT', 155, 0.75);
      const secondFile = logger.filePath();
      expect(secondFile).not.toBe(firstFile);
      expect(fs.existsSync(firstFile)).toBe(true);
      expect(fs.existsSync(secondFile)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

// ── demo-fapi config ───────────────────────────────────────────────────────

describe('binanceRestBase / binanceWsBase with usdm_demo', () => {
  it('returns demo-fapi REST for usdm_demo product', () => {
    const cfg = baseCfg({ BINANCE_PRODUCT: 'usdm_demo' as AppConfig['BINANCE_PRODUCT'] });
    expect(binanceRestBase(cfg)).toBe('https://demo-fapi.binance.com');
  });

  it('returns demo-fstream WS for usdm_demo product', () => {
    const cfg = baseCfg({ BINANCE_PRODUCT: 'usdm_demo' as AppConfig['BINANCE_PRODUCT'] });
    expect(binanceWsBase(cfg)).toBe('wss://demo-fstream.binance.com');
  });

  it('still returns mainnet for plain usdm', () => {
    const cfg = baseCfg({ BINANCE_PRODUCT: 'usdm' });
    expect(binanceRestBase(cfg)).toBe('https://fapi.binance.com');
    expect(binanceWsBase(cfg)).toBe('wss://fstream.binance.com');
  });

  it('explicit override takes precedence over usdm_demo', () => {
    const cfg = baseCfg({
      BINANCE_PRODUCT: 'usdm_demo' as AppConfig['BINANCE_PRODUCT'],
      BINANCE_REST_BASE: 'https://custom.example.com',
      BINANCE_WS_BASE: 'wss://custom.example.com',
    });
    expect(binanceRestBase(cfg)).toBe('https://custom.example.com');
    expect(binanceWsBase(cfg)).toBe('wss://custom.example.com');
  });
});
