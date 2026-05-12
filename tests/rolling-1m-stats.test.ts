import { describe, expect, it } from 'vitest';
import { Rolling1mTradeStats } from '../ui/rolling-1m-stats.js';

describe('Rolling1mTradeStats', () => {
  it('computes VWAP and volume over trades in the window', () => {
    const r = new Rolling1mTradeStats();
    const t0 = 1_000_000;
    r.ingest(100, 1, t0);
    r.ingest(200, 1, t0 + 1000);
    const s = r.snapshot();
    expect(s.volume).toBe(2);
    expect(s.vwap).toBeCloseTo(150, 5);
  });

  it('drops trades older than 60 seconds', () => {
    const r = new Rolling1mTradeStats();
    const now = 120_000;
    r.ingest(100, 1, now - 61_000);
    r.ingest(200, 2, now);
    const s = r.snapshot();
    expect(s.volume).toBe(2);
    expect(s.vwap).toBe(200);
  });

  it('reset clears the buffer', () => {
    const r = new Rolling1mTradeStats();
    r.ingest(10, 1, 500_000);
    r.reset();
    expect(r.snapshot().vwap).toBeNull();
  });
});
