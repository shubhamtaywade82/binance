import { describe, expect, it } from 'vitest';
import {
  computeRestRetryDelayMs,
  DEFAULT_BINANCE_REST_RETRY_POLICY,
  isRetryableBinanceRestHttpStatus,
  parseRetryAfterSeconds,
} from '../src/binance/rest-retry';

describe('isRetryableBinanceRestHttpStatus', () => {
  it('treats 408, 429, and 5xx as retryable', () => {
    expect(isRetryableBinanceRestHttpStatus(408)).toBe(true);
    expect(isRetryableBinanceRestHttpStatus(429)).toBe(true);
    expect(isRetryableBinanceRestHttpStatus(500)).toBe(true);
    expect(isRetryableBinanceRestHttpStatus(503)).toBe(true);
  });

  it('does not retry other 4xx', () => {
    expect(isRetryableBinanceRestHttpStatus(400)).toBe(false);
    expect(isRetryableBinanceRestHttpStatus(401)).toBe(false);
    expect(isRetryableBinanceRestHttpStatus(418)).toBe(false);
  });
});

describe('parseRetryAfterSeconds', () => {
  it('reads decimal Retry-After seconds', () => {
    expect(parseRetryAfterSeconds({ 'retry-after': '2.5' })).toBe(2.5);
  });

  it('returns null when absent', () => {
    expect(parseRetryAfterSeconds(undefined)).toBeNull();
  });
});

describe('computeRestRetryDelayMs', () => {
  it('honors Retry-After as a floor against jitter', () => {
    const policy = { ...DEFAULT_BINANCE_REST_RETRY_POLICY, maxDelayMs: 60_000 };
    const delay = computeRestRetryDelayMs({
      attemptIndex: 0,
      policy,
      responseHeaders: { 'retry-after': '3' },
      random01: () => 0,
    });
    expect(delay).toBeGreaterThanOrEqual(3000);
    expect(delay).toBeLessThanOrEqual(policy.maxDelayMs);
  });

  it('uses deterministic jitter when random01 is fixed', () => {
    const policy = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 8000 };
    expect(
      computeRestRetryDelayMs({
        attemptIndex: 2,
        policy,
        responseHeaders: undefined,
        random01: () => 0.5,
      }),
    ).toBe(Math.floor(0.5 * Math.min(8000, 1000 * 2 ** 2)));
  });
});
