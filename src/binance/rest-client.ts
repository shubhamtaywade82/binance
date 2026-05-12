import crypto from 'node:crypto';
import axios, { type AxiosRequestConfig } from 'axios';

export interface BinanceRestClientOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  /** Default request timeout in ms. */
  timeoutMs?: number;
  /** Extra ms window for Binance server clock skew. */
  recvWindow?: number;
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

function signQuery(secret: string, queryString: string): string {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function buildQueryString(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * Binance FAPI HMAC-SHA256 signed REST client.
 * Handles GET/POST/PUT/DELETE with automatic timestamp + signature injection.
 */
export class BinanceRestClient {
  private readonly opts: Required<BinanceRestClientOptions>;

  constructor(opts: BinanceRestClientOptions) {
    this.opts = {
      timeoutMs: 15_000,
      recvWindow: 5_000,
      ...opts,
    };
  }

  /** Unsigned public request (no API key). */
  async publicGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
    const { data } = await axios.get<T>(url, {
      params,
      timeout: this.opts.timeoutMs,
      headers: { 'X-MBX-APIKEY': this.opts.apiKey },
      validateStatus: null,
    } as AxiosRequestConfig);
    return data;
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

  private async signed<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean>,
  ): Promise<T> {
    const url = `${this.opts.baseUrl}${path}`;
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

    const { data, status } = await axios.request<T>(config);

    if (status < 200 || status >= 300) {
      const err = data as unknown as BinanceApiError | null;
      throw new BinanceRestError(
        status,
        err && typeof err === 'object' && 'code' in err ? (err as BinanceApiError) : null,
      );
    }
    return data;
  }
}
