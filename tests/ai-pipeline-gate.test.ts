import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamAligner } from '../src/ai/stream-aligner';
import { StaleGuard } from '../src/ai/stale-guard';
import { volatilitySizedPosition } from '../src/ai/volatility-sizer';
import { optimalHoldTimeMs } from '../src/ai/hold-time-optimizer';
import { shouldSkipEntry } from '../src/ai/execution-gate';
import type { ExtendedModelOutput } from '../src/ai/model-types';

describe('StreamAligner', () => {
  it('reports aligned when all streams are within skew', () => {
    const aligner = new StreamAligner(['depth', 'trade']);
    const now = Date.now();
    aligner.update('depth', now);
    aligner.update('trade', now - 50);
    expect(aligner.isAligned(100)).toBe(true);
  });

  it('reports not aligned when streams diverge', () => {
    const aligner = new StreamAligner(['depth', 'trade']);
    const now = Date.now();
    aligner.update('depth', now);
    aligner.update('trade', now - 500);
    expect(aligner.isAligned(100)).toBe(false);
  });

  it('identifies stalest stream', () => {
    const aligner = new StreamAligner(['depth', 'trade', 'markPrice']);
    const now = Date.now();
    aligner.update('depth', now);
    aligner.update('trade', now - 1000);
    aligner.update('markPrice', now - 200);
    expect(aligner.stalestStream().stream).toBe('trade');
  });

  it('returns uninitialized stream as stalest', () => {
    const aligner = new StreamAligner(['depth', 'trade']);
    aligner.update('depth', Date.now());
    expect(aligner.stalestStream().stream).toBe('trade');
  });
});

describe('StaleGuard', () => {
  it('reports all stale initially', () => {
    const guard = new StaleGuard(['depth', 'trade']);
    expect(guard.anyStale()).toBe(true);
    expect(guard.staleSources()).toEqual(['depth', 'trade']);
  });

  it('reports fresh after markFresh', () => {
    const guard = new StaleGuard(['depth'], 1000);
    guard.markFresh('depth');
    expect(guard.isStale('depth')).toBe(false);
    expect(guard.anyStale()).toBe(false);
  });

  it('reports stale after timeout', () => {
    const guard = new StaleGuard(['depth'], 50);
    guard.markFresh('depth');
    vi.useFakeTimers();
    vi.advanceTimersByTime(100);
    expect(guard.isStale('depth')).toBe(true);
    vi.useRealTimers();
  });
});

describe('volatilitySizedPosition', () => {
  it('returns base qty when vol matches baseline', () => {
    const result = volatilitySizedPosition(10, 0.003);
    expect(result).toBeCloseTo(10);
  });

  it('scales down when vol is higher than baseline', () => {
    const result = volatilitySizedPosition(10, 0.006);
    expect(result).toBe(5);
  });

  it('scales up when vol is lower than baseline', () => {
    const result = volatilitySizedPosition(10, 0.002);
    expect(result).toBe(15);
  });

  it('clamps to maxScaleDown', () => {
    const result = volatilitySizedPosition(10, 0.1);
    expect(result).toBe(2.5);
  });

  it('clamps to maxScaleUp', () => {
    const result = volatilitySizedPosition(10, 0.0001);
    expect(result).toBe(15);
  });

  it('returns 0 for non-positive base qty', () => {
    expect(volatilitySizedPosition(0, 0.003)).toBe(0);
    expect(volatilitySizedPosition(-1, 0.003)).toBe(0);
  });

  it('returns base qty for invalid vol', () => {
    expect(volatilitySizedPosition(10, 0)).toBe(10);
    expect(volatilitySizedPosition(10, NaN)).toBe(10);
  });
});

describe('optimalHoldTimeMs', () => {
  const baseOutput: ExtendedModelOutput = { p_up: 0.7, p_down: 0.15, p_flat: 0.15 };

  it('returns default hold time with no regime or expected return', () => {
    expect(optimalHoldTimeMs(baseOutput)).toBe(30_000);
  });

  it('returns min hold for chop regime', () => {
    expect(optimalHoldTimeMs({ ...baseOutput, regime: 'chop' })).toBe(5_000);
  });

  it('doubles hold for trend regime', () => {
    expect(optimalHoldTimeMs({ ...baseOutput, regime: 'trend' })).toBe(60_000);
  });

  it('extends hold for higher expected return', () => {
    const withReturn = optimalHoldTimeMs({ ...baseOutput, expected_return: 0.05 });
    expect(withReturn).toBeGreaterThan(30_000);
  });

  it('clamps to max hold time', () => {
    const extreme = optimalHoldTimeMs({ ...baseOutput, regime: 'trend', expected_return: 1.0 });
    expect(extreme).toBe(300_000);
  });
});

describe('shouldSkipEntry', () => {
  const baseContext = {
    spreadBps: 5,
    bookThinning: 0,
    volRegimeFlag: 0,
    cancelIntensity: 0,
    liquidityGap: 0.1,
  };

  it('passes normal conditions', () => {
    expect(shouldSkipEntry(baseContext)).toEqual({ skip: false });
  });

  it('blocks on wide spread', () => {
    const result = shouldSkipEntry({ ...baseContext, spreadBps: 20 });
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('spread');
  });

  it('blocks on rapid book thinning', () => {
    const result = shouldSkipEntry({ ...baseContext, bookThinning: -0.15 });
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('thinning');
  });

  it('blocks on vol regime with large liquidity gap', () => {
    const result = shouldSkipEntry({ ...baseContext, volRegimeFlag: 1, liquidityGap: 0.8 });
    expect(result.skip).toBe(true);
    expect(result.reason).toContain('vol regime');
  });

  it('allows vol regime with small liquidity gap', () => {
    const result = shouldSkipEntry({ ...baseContext, volRegimeFlag: 1, liquidityGap: 0.2 });
    expect(result.skip).toBe(false);
  });
});
