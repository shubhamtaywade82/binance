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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-fills-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeAdapter(): { adapter: PaperExecutionAdapter; book: BookTickerFeed } {
  const book = new BookTickerFeed({ wsBase: 'wss://example', symbols: ['SOLUSDT'] });
  const wallet = new PaperWallet(10_000);
  const liquidation = new LiquidationEngine(0.005);
  const funding = new FundingEngine({ binanceRestBase: 'https://example', pollSec: 60 });
  const ledger = new Ledger(dir);
  const adapter = new PaperExecutionAdapter({
    wallet, book, liquidation, funding, ledger,
    takerFee: 0.0005, makerFee: 0.0002,
    baseSlippageBps: 0, latencyMs: 0,
    equitySnapshotMs: 1_000_000,
    symbolFor: () => 'SOLUSDT',
  });
  return { adapter, book };
}

describe('PaperExecutionAdapter fills', () => {
  it('LONG opens above ask, closes below bid', async () => {
    const { adapter, book } = makeAdapter();
    book.ingest({ symbol: 'SOLUSDT', bestBid: 99.9, bestAsk: 100.1, spread: 0.2, ts: Date.now() });
    const open = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    expect(open.ok).toBe(true);
    expect(open.fill.price).toBeGreaterThanOrEqual(100.1);
    const closed = await adapter.closePosition(open.orderId, 'MANUAL');
    expect(closed.exitPrice).toBeLessThanOrEqual(99.9);
  });

  it('SHORT opens below bid, closes above ask', async () => {
    const { adapter, book } = makeAdapter();
    book.ingest({ symbol: 'SOLUSDT', bestBid: 99.9, bestAsk: 100.1, spread: 0.2, ts: Date.now() });
    const open = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'SHORT', quantity: 1, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    expect(open.ok).toBe(true);
    expect(open.fill.price).toBeLessThanOrEqual(99.9);
    const closed = await adapter.closePosition(open.orderId, 'MANUAL');
    expect(closed.exitPrice).toBeGreaterThanOrEqual(100.1);
  });

  it('rejects when wallet has insufficient margin', async () => {
    const book = new BookTickerFeed({ wsBase: 'wss://example', symbols: ['SOLUSDT'] });
    book.ingest({ symbol: 'SOLUSDT', bestBid: 99, bestAsk: 101, spread: 2, ts: Date.now() });
    const wallet = new PaperWallet(1);
    const adapter = new PaperExecutionAdapter({
      wallet, book,
      liquidation: new LiquidationEngine(0.005),
      funding: new FundingEngine({ binanceRestBase: 'https://example', pollSec: 60 }),
      ledger: new Ledger(dir),
      takerFee: 0.0005, makerFee: 0.0002,
      baseSlippageBps: 0, latencyMs: 0, equitySnapshotMs: 1_000_000,
      symbolFor: () => 'SOLUSDT',
    });
    const r = await adapter.placeOrder({
      pair: 'B-SOL_USDT', side: 'LONG', quantity: 100, leverage: 10,
      marginCurrency: 'USDT', referencePrice: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('insufficient_margin');
  });
});
