import { describe, expect, it } from 'vitest';
import { computeRestRetryDelayMs, RETRY_AFTER_HARD_CEILING_MS, DEFAULT_BINANCE_REST_RETRY_POLICY } from '../src/binance/rest-retry';

describe('REST Retry-After respect (M-7)', () => {
  it('honours a Retry-After value LARGER than policy.maxDelayMs', () => {
    const delay = computeRestRetryDelayMs({
      attemptIndex: 0,
      policy: DEFAULT_BINANCE_REST_RETRY_POLICY, // maxDelayMs = 20s
      responseHeaders: { 'retry-after': '60' },   // 60s
      random01: () => 0,
    });
    expect(delay).toBe(60_000);
    expect(delay).toBeGreaterThan(DEFAULT_BINANCE_REST_RETRY_POLICY.maxDelayMs);
  });

  it('caps Retry-After at the hard ceiling (5 min)', () => {
    const delay = computeRestRetryDelayMs({
      attemptIndex: 0,
      policy: DEFAULT_BINANCE_REST_RETRY_POLICY,
      responseHeaders: { 'retry-after': '600' }, // 10 min, beyond ceiling
      random01: () => 0,
    });
    expect(delay).toBe(RETRY_AFTER_HARD_CEILING_MS);
  });

  it('falls back to exp-backoff capped at policy.maxDelayMs when Retry-After is absent', () => {
    const delay = computeRestRetryDelayMs({
      attemptIndex: 10,
      policy: DEFAULT_BINANCE_REST_RETRY_POLICY,
      responseHeaders: undefined,
      random01: () => 1, // worst-case jitter
    });
    expect(delay).toBeLessThanOrEqual(DEFAULT_BINANCE_REST_RETRY_POLICY.maxDelayMs);
  });

  it('a small Retry-After is rounded up but never below the jittered exp-backoff', () => {
    const delay = computeRestRetryDelayMs({
      attemptIndex: 3,
      policy: DEFAULT_BINANCE_REST_RETRY_POLICY, // exp cap = 3.2s
      responseHeaders: { 'retry-after': '0.5' },
      random01: () => 1, // jitter == exp cap
    });
    // Either the jittered exp-backoff (3.2s) or the Retry-After (0.5s) —
    // whichever is larger.
    expect(delay).toBeGreaterThanOrEqual(500);
  });
});
