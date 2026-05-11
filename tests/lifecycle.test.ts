import { describe, expect, it, vi } from 'vitest';
import { Lifecycle } from '../src/lifecycle';

describe('Lifecycle', () => {
  it('invokes stop functions in reverse registration order', async () => {
    const calls: string[] = [];
    const lc = new Lifecycle({ forceExitMs: 0 });
    lc.register('a', () => { calls.push('a'); });
    lc.register('b', () => { calls.push('b'); });
    lc.register('c', () => { calls.push('c'); });
    await lc.shutdown('test');
    expect(calls).toEqual(['c', 'b', 'a']);
  });

  it('is idempotent — repeated shutdown returns same promise', async () => {
    const stop = vi.fn();
    const lc = new Lifecycle({ forceExitMs: 0 });
    lc.register('x', stop);
    const p1 = lc.shutdown('s1');
    const p2 = lc.shutdown('s2');
    expect(p1).toBe(p2);
    await p1;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('continues after a stop throws', async () => {
    const calls: string[] = [];
    const lc = new Lifecycle({ forceExitMs: 0 });
    lc.register('first', () => { calls.push('first'); });
    lc.register('boom', () => { throw new Error('nope'); });
    lc.register('last', () => { calls.push('last'); });
    await lc.shutdown('test');
    // Reverse order: last (push), boom (throw, swallowed), first (push)
    expect(calls).toEqual(['last', 'first']);
  });

  it('enforces per-stop timeout for hung promises', async () => {
    let resolved = false;
    const lc = new Lifecycle({ defaultTimeoutMs: 30, forceExitMs: 0 });
    lc.register('hang', () => new Promise<void>((r) => setTimeout(() => { resolved = true; r(); }, 1000)));
    lc.register('quick', async () => undefined);
    await lc.shutdown('to');
    expect(resolved).toBe(false); // timed out before completion
  });

  it('isShuttingDown reflects state', async () => {
    const lc = new Lifecycle({ forceExitMs: 0 });
    expect(lc.isShuttingDown()).toBe(false);
    const p = lc.shutdown('go');
    expect(lc.isShuttingDown()).toBe(true);
    await p;
  });
});
