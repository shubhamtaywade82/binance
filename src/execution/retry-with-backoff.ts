export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number; // ±percentage randomness
  retryableStatusCodes: number[];
}

const DEFAULT_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitterFactor: 0.3,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

export class RetryError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: Error,
  ) {
    super(`All ${attempts} retry attempts exhausted: ${lastError.message}`);
    this.name = 'RetryError';
  }
}

function extractStatusCode(error: unknown): number | null {
  if (error && typeof error === 'object') {
    if ('status' in error && typeof (error as Record<string, unknown>).status === 'number') {
      return (error as Record<string, unknown>).status as number;
    }
    if ('response' in error) {
      const resp = (error as Record<string, unknown>).response;
      if (resp && typeof resp === 'object' && 'status' in resp) {
        return (resp as Record<string, number>).status;
      }
    }
  }
  if (error instanceof Error) {
    const match = error.message.match(/\b(4\d{2}|5\d{2})\b/);
    if (match) return Number(match[1]);
  }
  return null;
}

function isRetryable(error: unknown, cfg: RetryConfig, shouldRetry?: (e: unknown) => boolean): boolean {
  if (shouldRetry?.(error)) return true;

  const status = extractStatusCode(error);
  if (status !== null && cfg.retryableStatusCodes.includes(status)) return true;

  return false;
}

function computeDelay(attempt: number, cfg: RetryConfig): number {
  const exponential = cfg.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, cfg.maxDelayMs);
  const jitter = 1 + (Math.random() * 2 - 1) * cfg.jitterFactor;
  return capped * jitter;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config?: Partial<RetryConfig>,
  shouldRetry?: (error: unknown) => boolean,
): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_CONFIG, ...config };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === cfg.maxRetries || !isRetryable(err, cfg, shouldRetry)) {
        throw new RetryError(attempt + 1, lastError);
      }

      const delay = computeDelay(attempt, cfg);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new RetryError(cfg.maxRetries + 1, lastError!);
}
