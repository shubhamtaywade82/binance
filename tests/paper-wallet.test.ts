import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PaperWallet } from '../src/execution/paper/wallet';

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PaperWallet', () => {
  it('reserves and releases margin within balance', () => {
    const w = new PaperWallet(1000);
    expect(w.reserveMargin(400)).toBe(true);
    expect(w.state().usedMarginUsdt).toBe(400);
    expect(w.state().availableUsdt).toBe(600);
    w.releaseMargin(400);
    expect(w.state().usedMarginUsdt).toBe(0);
  });

  it('rejects reservation that exceeds available', () => {
    const w = new PaperWallet(100);
    expect(w.reserveMargin(150)).toBe(false);
    expect(w.state().usedMarginUsdt).toBe(0);
  });

  it('applies realized PnL into balance and equity', () => {
    const w = new PaperWallet(1000);
    w.applyRealized(50);
    expect(w.state().balanceUsdt).toBe(1050);
    expect(w.state().realizedPnlUsdt).toBe(50);
    expect(w.state().equityUsdt).toBe(1050);
  });

  it('equity = balance + unrealized', () => {
    const w = new PaperWallet(1000);
    w.setUnrealized(25);
    expect(w.state().equityUsdt).toBe(1025);
  });

  it('persists to disk atomically and reloads', () => {
    const file = path.join(tmpDir, 'wallet.json');
    const w = new PaperWallet(1000, file);
    w.reserveMargin(200);
    w.applyRealized(33);
    w.flushToDisk();
    expect(fs.existsSync(file)).toBe(true);
    const w2 = new PaperWallet(0, file);
    w2.loadFromDisk();
    expect(w2.state().balanceUsdt).toBe(1033);
    expect(w2.state().usedMarginUsdt).toBe(200);
  });
});
