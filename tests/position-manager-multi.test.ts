import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PositionManager } from '../src/strategy/position-manager';
import { RiskManager } from '../src/strategy/risk';
import type { AppConfig } from '../src/config';
import type {
  CloseReason,
  ClosedPosition,
  ExecutionAdapter,
  OrderRequest,
  OrderResult,
} from '../src/execution/types';
import { tierFor } from '../src/config/asset-tiers';

const PREC = { tickSize: 0.01, stepSize: 0.001, minQty: 0.001 };

const baseCfg = (over: Partial<AppConfig> = {}): AppConfig => ({
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
  LEVERAGE: 5,
  CAPITAL_PER_TRADE: 20000,
  CAPITAL_PER_TRADE_INR: 20000,
  CAPITAL_PER_TRADE_USDT: 1000,
  INR_PER_USDT: 85,
  TARGET_PNL_PCT: 0.10,
  STOP_LOSS_PCT: 0.05,
  TP_PRICE_PCT: 0.015,
  SL_PRICE_PCT: 0.01,
  MIN_CONFIDENCE: 0.65,
  MIN_SMC_SCORE: 2,
  MAX_OPEN_POSITIONS: 0,
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

const noopLog = { info: () => undefined, warn: () => undefined };

const makeAdapter = (): ExecutionAdapter => {
  let counter = 0;
  return {
    name: 'paper',
    async placeOrder(req: OrderRequest): Promise<OrderResult> {
      counter += 1;
      return {
        ok: true,
        orderId: `order-${counter}`,
        fill: {
          price: req.referencePrice,
          quantity: req.quantity,
          feeUsdt: 0,
          slippageUsdt: 0,
          latencyMs: 0,
          timestamp: Date.now(),
        },
      };
    },
    async closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
      return {
        orderId,
        side: 'LONG',
        entryPrice: 100,
        exitPrice: 100,
        quantity: 0.1,
        reason,
        grossUsdt: 0,
        feesUsdt: 0,
        fundingUsdt: 0,
        netUsdt: 0,
        openedAt: 0,
        closedAt: Date.now(),
      };
    },
  };
};

let tmpCsv = '';

beforeEach(() => {
  tmpCsv = path.join(os.tmpdir(), `trades-multi-${Date.now()}-${Math.random()}.csv`);
});

afterEach(() => {
  if (fs.existsSync(tmpCsv)) fs.unlinkSync(tmpCsv);
});

const buildPm = (over: Partial<AppConfig> = {}): PositionManager => {
  const cfg = baseCfg({ TRADE_LOG_PATH: tmpCsv, TRADES_CSV_PATH: tmpCsv, ...over });
  return new PositionManager(cfg, makeAdapter(), new RiskManager(cfg), noopLog);
};

describe('PositionManager multi-symbol', () => {
  it('opens three concurrent positions across distinct symbols', async () => {
    const pm = buildPm();
    const a = await pm.open('LONG', 100, PREC, 'SOLUSDT', 'B-SOL_USDT', tierFor('SOLUSDT') ?? undefined);
    const b = await pm.open('LONG', 50_000, PREC, 'BTCUSDT', 'B-BTC_USDT', tierFor('BTCUSDT') ?? undefined);
    const c = await pm.open('SHORT', 3_000, PREC, 'ETHUSDT', 'B-ETH_USDT', tierFor('ETHUSDT') ?? undefined);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(pm.openCount()).toBe(3);
    expect(pm.openSymbols().sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  });

  it('rejects a second open for the same symbol', async () => {
    const pm = buildPm();
    const first = await pm.open('LONG', 100, PREC, 'SOLUSDT', 'B-SOL_USDT', tierFor('SOLUSDT') ?? undefined);
    expect(first).not.toBeNull();
    const second = await pm.open('SHORT', 100, PREC, 'SOLUSDT', 'B-SOL_USDT', tierFor('SOLUSDT') ?? undefined);
    // Second call should return the existing position (not throw, not double-open).
    expect(second).toBe(first);
    expect(pm.openCount()).toBe(1);
  });

  it('closes one symbol while others stay open', async () => {
    const pm = buildPm();
    await pm.open('LONG', 100, PREC, 'SOLUSDT', 'B-SOL_USDT', tierFor('SOLUSDT') ?? undefined);
    await pm.open('LONG', 50_000, PREC, 'BTCUSDT', 'B-BTC_USDT', tierFor('BTCUSDT') ?? undefined);
    expect(pm.openCount()).toBe(2);
    const evt = await pm.close('SOLUSDT', 200, 'MANUAL');
    expect(evt?.reason).toBe('MANUAL');
    expect(pm.openCount()).toBe(1);
    expect(pm.hasPosition('SOLUSDT')).toBe(false);
    expect(pm.hasPosition('BTCUSDT')).toBe(true);
  });

  it('enforces MAX_OPEN_POSITIONS across symbols', async () => {
    const pm = buildPm({ MAX_OPEN_POSITIONS: 2 });
    await pm.open('LONG', 100, PREC, 'SOLUSDT', 'B-SOL_USDT', tierFor('SOLUSDT') ?? undefined);
    await pm.open('LONG', 50_000, PREC, 'BTCUSDT', 'B-BTC_USDT', tierFor('BTCUSDT') ?? undefined);
    const third = await pm.open('SHORT', 3_000, PREC, 'ETHUSDT', 'B-ETH_USDT', tierFor('ETHUSDT') ?? undefined);
    expect(third).toBeNull();
    expect(pm.openCount()).toBe(2);
  });

  it('routes onMark to the right position via symbol', async () => {
    const pm = buildPm();
    await pm.open('LONG', 100, PREC, 'SOLUSDT', 'B-SOL_USDT', tierFor('SOLUSDT') ?? undefined);
    await pm.open('LONG', 50_000, PREC, 'BTCUSDT', 'B-BTC_USDT', tierFor('BTCUSDT') ?? undefined);
    // SOL tier tpPct=0.010 → TP at 101.0; BTC tier tpPct=0.007 → TP at 50350.
    const solClose = await pm.onMark('SOLUSDT', 101.5, 'LONG');
    expect(solClose?.reason).toBe('TP');
    expect(pm.hasPosition('SOLUSDT')).toBe(false);
    expect(pm.hasPosition('BTCUSDT')).toBe(true);
    // A SOL mark should now be a no-op, BTC still active.
    const noop = await pm.onMark('SOLUSDT', 200, 'LONG');
    expect(noop).toBeNull();
  });
});
