import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PaperExecutionAdapter } from '../src/execution/paper/adapter';
import { PaperWallet } from '../src/execution/paper/wallet';
import { LiquidationEngine } from '../src/execution/paper/liquidation';
import { FundingEngine } from '../src/execution/paper/funding';
import { Ledger } from '../src/execution/paper/ledger';
import { BookTickerFeed } from '../src/execution/paper/book-ticker-feed';

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-adapter-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(opts: { initialUsdt?: number; maint?: number; snapMs?: number } = {}) {
  const book = new BookTickerFeed({ wsBase: 'wss://example', symbols: ['SOLUSDT'] });
  const wallet = new PaperWallet(opts.initialUsdt ?? 10_000);
  const liquidation = new LiquidationEngine(opts.maint ?? 0.005);
  const funding = new FundingEngine({ binanceRestBase: 'https://example', pollSec: 60 });
  const ledger = new Ledger(dir);
  const adapter = new PaperExecutionAdapter({
    wallet, book, liquidation, funding, ledger,
    takerFee: 0.0005, makerFee: 0.0002,
    baseSlippageBps: 0, latencyMs: 0,
    equitySnapshotMs: opts.snapMs ?? 0,
    symbolFor: () => 'SOLUSDT',
  });
  return { adapter, book, wallet, liquidation };
}

describe('PaperExecutionAdapter roundtrip', () => {
  it('open -> mark up -> manual TP exit writes ledger and grows balance', async () => {
    const { adapter, book, wallet } = makeAdapter();
    book.ingest({ symbol: 'SOLUSDT', bestBid: 99.95, bestAsk: 100.05, spread: 0.1, ts: Date.now() });
    const open = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    expect(open.ok).toBe(true);
    book.ingest({ symbol: 'SOLUSDT', bestBid: 109.95, bestAsk: 110.05, spread: 0.1, ts: Date.now() });
    adapter.onMark('SOLUSDT', 110);
    const closed = await adapter.closePosition(open.orderId, 'TP');
    expect(closed.reason).toBe('TP');
    expect(closed.netUsdt).toBeGreaterThan(0);
    expect(wallet.state().balanceUsdt).toBeGreaterThan(10_000);
    const tradesPath = path.join(dir, 'trades.jsonl');
    expect(fs.existsSync(tradesPath)).toBe(true);
    const lines = fs.readFileSync(tradesPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
  });

  it('SL exit produces negative net', async () => {
    const { adapter, book } = makeAdapter();
    book.ingest({ symbol: 'SOLUSDT', bestBid: 99.95, bestAsk: 100.05, spread: 0.1, ts: Date.now() });
    const open = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    expect(open.ok).toBe(true);
    book.ingest({ symbol: 'SOLUSDT', bestBid: 95, bestAsk: 95.1, spread: 0.1, ts: Date.now() });
    const closed = await adapter.closePosition(open.orderId, 'SL');
    expect(closed.reason).toBe('SL');
    expect(closed.netUsdt).toBeLessThan(0);
  });

  it('liquidation auto-closes via onMark when mark crosses liq price', async () => {
    const { adapter, book, liquidation } = makeAdapter();
    book.ingest({ symbol: 'SOLUSDT', bestBid: 99.95, bestAsk: 100.05, spread: 0.1, ts: Date.now() });
    const open = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    expect(open.ok).toBe(true);
    expect(liquidation.triggered(50)).toHaveLength(1);
    book.ingest({ symbol: 'SOLUSDT', bestBid: 50, bestAsk: 50.1, spread: 0.1, ts: Date.now() });
    adapter.onMark('SOLUSDT', 50);
    await new Promise((r) => setTimeout(r, 10));
    const tradesPath = path.join(dir, 'trades.jsonl');
    expect(fs.existsSync(tradesPath)).toBe(true);
    const trades = fs.readFileSync(tradesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(trades.some((t) => t.reason === 'LIQUIDATION')).toBe(true);
  });

  it('snapshots equity periodically when interval elapses', async () => {
    const { adapter, book } = makeAdapter({ snapMs: 0 });
    book.ingest({ symbol: 'SOLUSDT', bestBid: 99.95, bestAsk: 100.05, spread: 0.1, ts: Date.now() });
    await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    adapter.onMark('SOLUSDT', 101);
    const equityPath = path.join(dir, 'equity.jsonl');
    expect(fs.existsSync(equityPath)).toBe(true);
  });
});
