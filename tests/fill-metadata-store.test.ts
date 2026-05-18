import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { FillMetadataStore, type FillMetadata } from '../src/core/execution/fill-metadata-store';

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-meta-'));
  storePath = path.join(tmpDir, 'fills.json');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const meta = (orderId: string, symbol: string, side: 'LONG' | 'SHORT' = 'LONG'): FillMetadata => ({
  orderId,
  symbol,
  side,
  quantity: 1,
  price: 100,
  stopLoss: 99,
  takeProfit: 101.5,
  atrAtEntry: 0.5,
  openedAt: 1700000000000,
});

describe('FillMetadataStore (C-9)', () => {
  it('persists fills across instance recreation', () => {
    const a = new FillMetadataStore(storePath);
    a.upsert(meta('o-1', 'SOLUSDT'));
    a.upsert(meta('o-2', 'ETHUSDT', 'SHORT'));

    const b = new FillMetadataStore(storePath);
    expect(b.all()).toHaveLength(2);
    expect(b.get('o-1')?.symbol).toBe('SOLUSDT');
    expect(b.get('o-2')?.side).toBe('SHORT');
  });

  it('upsert overwrites the existing record', () => {
    const s = new FillMetadataStore(storePath);
    s.upsert(meta('o-1', 'SOLUSDT'));
    s.upsert({ ...meta('o-1', 'SOLUSDT'), price: 102, atrAtEntry: 0.6 });
    expect(s.get('o-1')?.price).toBe(102);
    expect(s.all()).toHaveLength(1);
  });

  it('remove drops the record from disk', () => {
    const s = new FillMetadataStore(storePath);
    s.upsert(meta('o-1', 'SOLUSDT'));
    s.remove('o-1');
    const fresh = new FillMetadataStore(storePath);
    expect(fresh.all()).toHaveLength(0);
  });

  it('bySymbol filters correctly', () => {
    const s = new FillMetadataStore(storePath);
    s.upsert(meta('o-1', 'SOLUSDT'));
    s.upsert(meta('o-2', 'ETHUSDT'));
    s.upsert(meta('o-3', 'SOLUSDT', 'SHORT'));
    const sol = s.bySymbol('SOLUSDT');
    expect(sol.map((m) => m.orderId).sort()).toEqual(['o-1', 'o-3']);
  });

  it('survives a corrupt file (loads empty, does not throw)', () => {
    fs.writeFileSync(storePath, 'not valid json{{');
    const s = new FillMetadataStore(storePath);
    expect(s.all()).toEqual([]);
    // Should be writable after a corrupt load.
    s.upsert(meta('o-1', 'SOLUSDT'));
    expect(s.get('o-1')).toBeDefined();
  });

  it('creates the parent directory automatically', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'fills.json');
    const s = new FillMetadataStore(nested);
    s.upsert(meta('o-1', 'SOLUSDT'));
    expect(fs.existsSync(nested)).toBe(true);
  });
});
