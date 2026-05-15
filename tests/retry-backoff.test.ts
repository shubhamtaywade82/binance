import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryWithBackoff, RetryError } from '../src/execution/retry-with-backoff';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('retryWithBackoff', () => {
  describe('success path', () => {
    it('returns immediately on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await retryWithBackoff(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns value after transient failure', async () => {
      const err = Object.assign(new Error('503'), { status: 503 });
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

      const result = await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 1 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('retryable status codes', () => {
    it('retries on 429', async () => {
      const err = Object.assign(new Error('rate limited'), { status: 429 });
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('done');

      const result = await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 1 });
      expect(result).toBe('done');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on 500', async () => {
      const err = Object.assign(new Error('internal'), { status: 500 });
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

      const result = await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 1 });
      expect(result).toBe('ok');
    });

    it('does not retry on 400 (non-retryable)', async () => {
      const err = Object.assign(new Error('bad request'), { status: 400 });
      const fn = vi.fn().mockRejectedValue(err);

      await expect(retryWithBackoff(fn, { baseDelayMs: 1 })).rejects.toThrow(RetryError);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom shouldRetry', () => {
    it('retries when shouldRetry returns true', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(
        fn,
        { baseDelayMs: 1, maxDelayMs: 1 },
        (e) => e instanceof Error && e.message === 'timeout',
      );
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('status code from response property (axios-style)', () => {
    it('detects status from error.response.status', async () => {
      const err = Object.assign(new Error('axios err'), {
        response: { status: 502 },
      });
      const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');

      const result = await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 1 });
      expect(result).toBe('ok');
    });
  });

  describe('status code from error message (string match)', () => {
    it('detects status code in error message', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('Request failed with status 503'))
        .mockResolvedValue('ok');

      const result = await retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 1 });
      expect(result).toBe('ok');
    });
  });

  describe('exhaustion', () => {
    it('throws RetryError after maxRetries', async () => {
      const err = Object.assign(new Error('down'), { status: 500 });
      const fn = vi.fn().mockRejectedValue(err);

      try {
        await retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(RetryError);
        const retryErr = e as RetryError;
        expect(retryErr.attempts).toBe(3); // initial + 2 retries
        expect(retryErr.lastError.message).toBe('down');
      }
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('exponential backoff timing', () => {
    it('increases delay exponentially', async () => {
      const err = Object.assign(new Error('fail'), { status: 500 });
      const fn = vi.fn().mockRejectedValue(err);

      vi.spyOn(Math, 'random').mockReturnValue(0.5); // neutralizes jitter

      const start = Date.now();
      await expect(
        retryWithBackoff(fn, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 10_000, jitterFactor: 0 }),
      ).rejects.toThrow(RetryError);

      const elapsed = Date.now() - start;
      // delays: 100 + 200 + 400 = 700ms total (with jitterFactor=0)
      expect(elapsed).toBeGreaterThanOrEqual(690);

      vi.spyOn(Math, 'random').mockRestore();
    });
  });

  describe('maxDelayMs cap', () => {
    it('caps delay at maxDelayMs', async () => {
      const err = Object.assign(new Error('fail'), { status: 500 });
      const fn = vi.fn().mockRejectedValue(err);

      vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const start = Date.now();
      await expect(
        retryWithBackoff(fn, { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 500, jitterFactor: 0 }),
      ).rejects.toThrow(RetryError);

      const elapsed = Date.now() - start;
      // both delays capped at 500ms => 1000ms total
      expect(elapsed).toBeGreaterThanOrEqual(990);
      expect(elapsed).toBeLessThan(1500);

      vi.spyOn(Math, 'random').mockRestore();
    });
  });

  describe('RetryError', () => {
    it('has correct name and message', () => {
      const inner = new Error('boom');
      const err = new RetryError(3, inner);
      expect(err.name).toBe('RetryError');
      expect(err.message).toContain('3 retry attempts exhausted');
      expect(err.lastError).toBe(inner);
      expect(err).toBeInstanceOf(Error);
    });
  });
});
