import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventWal, type WalEvent } from '../src/persistence/event-wal';

let tmpDir: string;
let walPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'event-wal-'));
  walPath = path.join(tmpDir, 'wal.ndjson');
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const mkEvent = (i: number): WalEvent => ({
  id: `evt-${i}`,
  type: 'execution.order.filled',
  ts: 1700000000000 + i,
  source: 'test',
  symbol: 'SOLUSDT',
  payload: { orderId: `o-${i}`, qty: i },
});

describe('EventWal (C-8)', () => {
  it('appends events and replays them in order', () => {
    const wal = new EventWal(walPath);
    wal.open();
    wal.append(mkEvent(1));
    wal.append(mkEvent(2));
    wal.append(mkEvent(3));
    wal.close();

    const wal2 = new EventWal(walPath);
    const events = wal2.replayAll();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('fsyncs after each append (event is durable before append returns)', () => {
    const wal = new EventWal(walPath);
    wal.append(mkEvent(1));
    // Read the file straight from disk WITHOUT closing the writer fd.
    const raw = fs.readFileSync(walPath, 'utf8');
    expect(raw).toContain('"evt-1"');
  });

  it('skips malformed lines on replay (crash mid-write)', () => {
    fs.writeFileSync(walPath, `${JSON.stringify(mkEvent(1))}\n{"id": "evt-2"` + '\n'); // truncated JSON
    const wal = new EventWal(walPath);
    const corrupted: string[] = [];
    const events = wal.replayAll((line) => corrupted.push(line));
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe('evt-1');
    expect(corrupted).toHaveLength(1);
  });

  it('compact() retains only events the predicate keeps', () => {
    const wal = new EventWal(walPath);
    wal.append(mkEvent(1));
    wal.append(mkEvent(2));
    wal.append(mkEvent(3));

    // Drop evt-1 and evt-2 (simulating ACK from Postgres).
    const flushed = new Set(['evt-1', 'evt-2']);
    const result = wal.compact((e) => !flushed.has(e.id));
    expect(result.kept).toBe(1);
    expect(result.dropped).toBe(2);

    const wal2 = new EventWal(walPath);
    const remaining = wal2.replayAll();
    expect(remaining.map((e) => e.id)).toEqual(['evt-3']);
  });

  it('compact() is a no-op when nothing should be dropped', () => {
    const wal = new EventWal(walPath);
    wal.append(mkEvent(1));
    const sizeBefore = wal.sizeBytes();
    const result = wal.compact(() => true);
    expect(result.dropped).toBe(0);
    expect(wal.sizeBytes()).toBe(sizeBefore);
  });

  it('reopens the file after compact() so subsequent appends still work', () => {
    const wal = new EventWal(walPath);
    wal.append(mkEvent(1));
    wal.append(mkEvent(2));
    wal.compact((e) => e.id !== 'evt-1');
    wal.append(mkEvent(3));

    const wal2 = new EventWal(walPath);
    const events = wal2.replayAll();
    expect(events.map((e) => e.id).sort()).toEqual(['evt-2', 'evt-3']);
  });

  it('handles concurrent open/close gracefully (idempotent)', () => {
    const wal = new EventWal(walPath);
    wal.open();
    wal.open();
    wal.close();
    wal.close();
    expect(() => wal.append(mkEvent(1))).not.toThrow();
  });

  it('creates the parent directory automatically', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'deep', 'wal.ndjson');
    const wal = new EventWal(nestedPath);
    wal.append(mkEvent(1));
    expect(fs.existsSync(nestedPath)).toBe(true);
  });
});
