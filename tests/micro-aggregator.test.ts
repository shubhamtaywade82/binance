import { describe, expect, it } from 'vitest';
import { MicroAggregator } from '../src/features/micro-aggregator';
import { RollingFeatureRing } from '../src/features/rolling-feature-ring';
import { MinMaxNormalizer } from '../src/features/min-max-normalizer';
import { FeatureBus } from '../src/features/feature-bus';

describe('MicroAggregator', () => {
  it('aggregates values within the window', () => {
    const agg = new MicroAggregator(1000);
    const t0 = 10_000;
    agg.push(10, t0);
    agg.push(20, t0 + 100);
    agg.push(30, t0 + 200);

    const snap = agg.snapshot();
    expect(snap.count).toBe(3);
    expect(snap.sum).toBe(60);
    expect(snap.mean).toBe(20);
    expect(snap.min).toBe(10);
    expect(snap.max).toBe(30);
    expect(snap.last).toBe(30);
  });

  it('evicts samples outside the window', () => {
    const agg = new MicroAggregator(1000);
    agg.push(100, 1000);
    agg.push(200, 2500);

    const snap = agg.snapshot();
    expect(snap.count).toBe(1);
    expect(snap.last).toBe(200);
  });

  it('returns zeroes on empty snapshot', () => {
    const agg = new MicroAggregator(5000);
    const snap = agg.snapshot();
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
    expect(snap.mean).toBe(0);
  });

  it('reset clears all samples', () => {
    const agg = new MicroAggregator(5000);
    agg.push(42, 1000);
    agg.reset();
    expect(agg.snapshot().count).toBe(0);
  });

  it('throws on non-positive windowMs', () => {
    expect(() => new MicroAggregator(0)).toThrow();
    expect(() => new MicroAggregator(-1)).toThrow();
  });
});

describe('RollingFeatureRing', () => {
  it('stores values up to capacity', () => {
    const ring = new RollingFeatureRing(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    expect(ring.size).toBe(3);
    expect(ring.toArray()).toEqual(new Float64Array([1, 2, 3]));
  });

  it('wraps around when exceeding capacity', () => {
    const ring = new RollingFeatureRing(3);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    ring.push(4);
    expect(ring.size).toBe(3);
    expect(ring.toArray()).toEqual(new Float64Array([2, 3, 4]));
    expect(ring.last()).toBe(4);
  });

  it('computes mean correctly', () => {
    const ring = new RollingFeatureRing(10);
    ring.push(10);
    ring.push(20);
    ring.push(30);
    expect(ring.mean()).toBeCloseTo(20, 10);
  });

  it('computes std correctly', () => {
    const ring = new RollingFeatureRing(10);
    for (const v of [2, 4, 4, 4, 5, 5, 7, 9]) ring.push(v);
    expect(ring.std()).toBeCloseTo(2, 0);
  });

  it('computes min and max', () => {
    const ring = new RollingFeatureRing(5);
    ring.push(5);
    ring.push(1);
    ring.push(9);
    expect(ring.min()).toBe(1);
    expect(ring.max()).toBe(9);
  });

  it('returns 0 for all stats when empty', () => {
    const ring = new RollingFeatureRing(5);
    expect(ring.mean()).toBe(0);
    expect(ring.std()).toBe(0);
    expect(ring.min()).toBe(0);
    expect(ring.max()).toBe(0);
    expect(ring.last()).toBe(0);
    expect(ring.size).toBe(0);
  });

  it('throws on non-positive capacity', () => {
    expect(() => new RollingFeatureRing(0)).toThrow();
  });
});

describe('MinMaxNormalizer', () => {
  it('normalizes values to [0, 1] range', () => {
    const norm = new MinMaxNormalizer(100);
    norm.normalize('price', 10);
    norm.normalize('price', 20);
    const result = norm.normalize('price', 15);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it('returns 0 when all values are identical', () => {
    const norm = new MinMaxNormalizer(100);
    norm.normalize('price', 5);
    norm.normalize('price', 5);
    const result = norm.normalize('price', 5);
    expect(result).toBe(0);
  });

  it('returns 1 for max value and 0 for min value', () => {
    const norm = new MinMaxNormalizer(100);
    norm.normalize('x', 0);
    norm.normalize('x', 100);
    expect(norm.normalize('x', 100)).toBeCloseTo(1, 5);
    expect(norm.normalize('x', 0)).toBeCloseTo(0, 5);
  });

  it('tracks separate ranges per key', () => {
    const norm = new MinMaxNormalizer(100);
    norm.normalize('a', 0);
    norm.normalize('a', 10);
    norm.normalize('b', 100);
    norm.normalize('b', 200);

    expect(norm.normalize('a', 5)).toBeCloseTo(0.5, 5);
    expect(norm.normalize('b', 150)).toBeCloseTo(0.5, 5);
  });

  it('reset clears state', () => {
    const norm = new MinMaxNormalizer(100);
    norm.normalize('x', 10);
    norm.normalize('x', 20);
    norm.reset();
    const result = norm.normalize('x', 15);
    expect(result).toBe(0);
  });
});

describe('FeatureBus', () => {
  it('stores and retrieves feature snapshots', () => {
    const bus = new FeatureBus();
    bus.update('BTCUSDT', { spread: 0.5, volume: 100 });

    const snap = bus.snapshot('BTCUSDT');
    expect(snap).not.toBeNull();
    expect(snap!.symbol).toBe('BTCUSDT');
    expect(snap!.features.spread).toBe(0.5);
    expect(snap!.features.volume).toBe(100);
  });

  it('returns null for unknown symbol', () => {
    const bus = new FeatureBus();
    expect(bus.snapshot('ETHUSDT')).toBeNull();
  });

  it('lists all symbols', () => {
    const bus = new FeatureBus();
    bus.update('BTCUSDT', { a: 1 });
    bus.update('ETHUSDT', { b: 2 });
    expect(bus.symbols().sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('allSnapshots returns all stored snapshots', () => {
    const bus = new FeatureBus();
    bus.update('BTCUSDT', { x: 1 });
    bus.update('SOLUSDT', { y: 2 });
    expect(bus.allSnapshots()).toHaveLength(2);
  });

  it('overwrites features on re-update', () => {
    const bus = new FeatureBus();
    bus.update('BTCUSDT', { a: 1 });
    bus.update('BTCUSDT', { a: 99 });
    expect(bus.snapshot('BTCUSDT')!.features.a).toBe(99);
  });
});
