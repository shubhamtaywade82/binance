import crypto from 'node:crypto';
import axios, { type AxiosRequestConfig, type AxiosResponse, isAxiosError } from 'axios';
import {
  computeRestRetryDelayMs,
  DEFAULT_BINANCE_REST_RETRY_POLICY,
  isRetryableBinanceRestHttpStatus,
  sleepMs,
  type BinanceRestRetryPolicy,
} from './rest-retry';

export interface BinanceRestClientOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
  /** Extra ms window for Binance server clock skew. */
  recvWindow?: number;
  /** Backoff + jitter on transient HTTP statuses and transport errors. */
  retry?: Partial<BinanceRestRetryPolicy>;
}

export interface BinanceApiError {
  code: number;
  msg: string;
}

export class BinanceRestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly binance: BinanceApiError | null,
    message?: string,
  ) {
    super(message ?? binance?.msg ?? `Binance REST error ${statusCode}`);
    this.name = 'BinanceRestError';
  }

  get binanceCode(): number | undefined {
    return this.binance?.code;
  }
}

const signQuery = (secret: string, queryString: string): string => {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

const buildQueryString = (params: Record<string, string | number | boolean>): string => {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

const parseBinanceApiError = (data: unknown): BinanceApiError | null => {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.code === 'number' && typeof d.msg === 'string') {
    return { code: d.code, msg: d.msg };
  }
  return null;
}

/**
 * Binance FAPI HMAC-SHA256 signed REST client.
 * Handles GET/POST/PUT/DELETE with automatic timestamp + signature injection.
 */
export class BinanceRestClient {
  private readonly opts: Required<Omit<BinanceRestClientOptions, 'retry'>>;
  private readonly retry: BinanceRestRetryPolicy;

  constructor(opts: BinanceRestClientOptions) {
    const { retry: retryPartial, ...rest } = opts;
    this.opts = {
      timeoutMs: 15_000,
      recvWindow: 5_000,
      ...rest,
    };
    this.retry = { ...DEFAULT_BINANCE_REST_RETRY_POLICY, ...retryPartial };
  }

  /** Unsigned public request (no API key). */
  async publicGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    return this.executeWithRetry<T>(() =>
      axios.get<T>(url, {
        params,
        timeout: this.opts.timeoutMs,
        headers: { 'X-MBX-APIKEY': this.opts.apiKey },
        validateStatus: null,
      } as AxiosRequestConfig),
    );
  }

  /** Signed GET — appends timestamp + signature. */
  async signedGet<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    return this.signed<T>('GET', path, params);
  }

  /** Signed POST — sends params as URL-encoded body (Binance convention). */
  async signedPost<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    return this.signed<T>('POST', path, params);
  }

  /** Signed PUT. */
  async signedPut<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    return this.signed<T>('PUT', path, params);
  }

  /** Signed DELETE. */
  async signedDelete<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    return this.signed<T>('DELETE', path, params);
  }

  private async executeWithRetry<T>(execute: () => Promise<AxiosResponse<T>>): Promise<T> {
    for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
      try {
        const res = await execute();
        if (res.status >= 200 && res.status < 300) {
          return res.data;
        }
        const binance = parseBinanceApiError(res.data);
        if (!isRetryableBinanceRestHttpStatus(res.status) || attempt === this.retry.maxAttempts - 1) {
          throw new BinanceRestError(res.status, binance);
        }
        const waitMs = computeRestRetryDelayMs({
          attemptIndex: attempt,
          policy: this.retry,
          responseHeaders: res.headers,
        });
        await sleepMs(waitMs);
      } catch (err) {
        if (!isAxiosError(err)) throw err;
        if (err.response) {
          const { status, data, headers } = err.response;
          const binance = parseBinanceApiError(data);
          if (!isRetryableBinanceRestHttpStatus(status) || attempt === this.retry.maxAttempts - 1) {
            throw new BinanceRestError(status, binance);
          }
          const waitMs = computeRestRetryDelayMs({
            attemptIndex: attempt,
            policy: this.retry,
            responseHeaders: headers,
          });
          await sleepMs(waitMs);
          continue;
        }
        if (attempt === this.retry.maxAttempts - 1) throw err;
        const waitMs = computeRestRetryDelayMs({
          attemptIndex: attempt,
          policy: this.retry,
          responseHeaders: undefined,
        });
        await sleepMs(waitMs);
      }
    }
    throw new Error('BinanceRestClient.executeWithRetry: exhausted attempts without throw');
  }

  private async signed<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean>,
  ): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;

    return this.executeWithRetry<T>(() => {
      const allParams: Record<string, string | number | boolean> = {
        ...params,
        timestamp: Date.now(),
        recvWindow: this.opts.recvWindow,
      };
      const qs = buildQueryString(allParams);
      const sig = signQuery(this.opts.apiSecret, qs);
      const finalQs = `${qs}&signature=${sig}`;

      const headers = {
        'X-MBX-APIKEY': this.opts.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      };

      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        timeout: this.opts.timeoutMs,
        validateStatus: null,
      };

      if (method === 'GET' || method === 'DELETE') {
        config.params = Object.fromEntries(new URLSearchParams(finalQs));
      } else {
        config.data = finalQs;
      }

      return axios.request<T>(config);
    });
  }
}
