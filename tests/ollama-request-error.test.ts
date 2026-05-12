import { describe, expect, it } from 'vitest';
import { formatOllamaRequestError } from '../src/ai/ollama-request-error';

describe('formatOllamaRequestError', () => {
  it('rewrites AbortSignal timeout message', () => {
    const out = formatOllamaRequestError(new Error('The operation was aborted due to timeout'), 25_000);
    expect(out).toContain('25');
    expect(out).toContain('AI_REQUEST_TIMEOUT_MS');
  });

  it('passes through other errors', () => {
    expect(formatOllamaRequestError(new Error('ECONNREFUSED'), 5000)).toBe('ECONNREFUSED');
  });
});
