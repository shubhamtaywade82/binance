import type { AxiosResponseHeaders, RawAxiosResponseHeaders } from 'axios';
import { AxiosHeaders } from 'axios';

export interface BinanceRestRetryPolicy {
  /** Total HTTP attempts (initial try + retries). Minimum 1. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_BINANCE_REST_RETRY_POLICY: BinanceRestRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 400,
  maxDelayMs: 20_000,
};

const readHeader = (headers: RawAxiosResponseHeaders | AxiosResponseHeaders | undefined, name: string): string | undefined => {
  if (!headers) return undefined;
  if (headers instanceof AxiosHeaders) {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  const v = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] !== undefined ? String(v[0]) : undefined;
  return v !== undefined && v !== null ? String(v) : undefined;
};

/** Parses `Retry-After` when it is a decimal-seconds delay (common on 429). */
export const parseRetryAfterSeconds = (headers: RawAxiosResponseHeaders | AxiosResponseHeaders | undefined): number | null => {
  const raw = readHeader(headers, 'retry-after');
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw.trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

export const isRetryableBinanceRestHttpStatus = (status: number): boolean => {
  if (status === 408 || status === 429) return true;
  return status >= 500 && status <= 599;
};

/** Full jitter in `[0, cap]` (AWS-style) capped by `policy.maxDelayMs`. */
export const computeRestRetryDelayMs = (params: {
  attemptIndex: number;
  policy: BinanceRestRetryPolicy;
  responseHeaders?: RawAxiosResponseHeaders | AxiosResponseHeaders;
  random01?: () => number;
}): number => {
  const { attemptIndex, policy, responseHeaders, random01 = Math.random } = params;
  const expCap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attemptIndex);
  const jittered = Math.floor(random01() * Math.max(1, expCap));
  const retryAfterSec = parseRetryAfterSeconds(responseHeaders);
  if (retryAfterSec === null) return Math.min(policy.maxDelayMs, Math.max(1, jittered));
  const fromHeader = Math.ceil(retryAfterSec * 1000);
  return Math.min(policy.maxDelayMs, Math.max(fromHeader, jittered));
};

export const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
