import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InferenceClient, FALLBACK_OUTPUT } from '../src/ai/inference-client';

describe('InferenceClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when circuit is open', async () => {
    const client = new InferenceClient({
      circuitBreakerThreshold: 2,
      circuitBreakerResetMs: 60_000,
      maxRetries: 0,
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    await client.predict({ spread: 1 });
    await client.predict({ spread: 1 });

    expect(client.isCircuitOpen()).toBe(true);
    const result = await client.predict({ spread: 1 });
    expect(result).toBeNull();
  });

  it('returns model output on successful response', async () => {
    const client = new InferenceClient();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ p_up: 0.7, p_down: 0.1, p_flat: 0.2 }),
    });

    const result = await client.predict({ spread: 1 });
    expect(result).toEqual({ p_up: 0.7, p_down: 0.1, p_flat: 0.2 });
    expect(client.failureCount).toBe(0);
  });

  it('returns null on HTTP error after retries', async () => {
    const client = new InferenceClient({ maxRetries: 1 });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const result = await client.predict({ spread: 1 });
    expect(result).toBeNull();
    expect(client.failureCount).toBe(1);
  });

  it('returns null on network error after retries', async () => {
    const client = new InferenceClient({ maxRetries: 0 });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await client.predict({ spread: 1 });
    expect(result).toBeNull();
  });

  it('resets circuit breaker after reset period', async () => {
    const client = new InferenceClient({
      circuitBreakerThreshold: 1,
      circuitBreakerResetMs: 10,
      maxRetries: 0,
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('down'));
    await client.predict({ spread: 1 });
    expect(client.isCircuitOpen()).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    expect(client.isCircuitOpen()).toBe(false);
  });

  it('resetCircuit manually clears state', () => {
    const client = new InferenceClient();
    (client as any).consecutiveFailures = 10;
    (client as any).circuitOpenUntil = Date.now() + 60_000;
    client.resetCircuit();
    expect(client.failureCount).toBe(0);
    expect(client.isCircuitOpen()).toBe(false);
  });

  it('FALLBACK_OUTPUT is a valid flat prediction', () => {
    expect(FALLBACK_OUTPUT.p_up).toBe(0);
    expect(FALLBACK_OUTPUT.p_down).toBe(0);
    expect(FALLBACK_OUTPUT.p_flat).toBe(1);
  });

  it('retries on first failure then succeeds', async () => {
    const client = new InferenceClient({ maxRetries: 1 });
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('transient');
      return { ok: true, json: async () => ({ p_up: 0.6, p_down: 0.2, p_flat: 0.2 }) };
    });

    const result = await client.predict({ spread: 1 });
    expect(result).toEqual({ p_up: 0.6, p_down: 0.2, p_flat: 0.2 });
    expect(client.failureCount).toBe(0);
  });
});
