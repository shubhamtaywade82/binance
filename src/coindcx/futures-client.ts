/**
 * Parity with coindcx-bot `CoinDCXApi` (JSON-body HMAC, clock-skew retry, futures paths).
 * @see ../coindcx-bot/src/gateways/coindcx-api.ts
 */
import axios, { type AxiosInstance } from 'axios';
import crypto from 'crypto';

const PATH_CREATE = '/exchange/v1/derivatives/futures/orders/create';
const PATH_CANCEL = '/exchange/v1/derivatives/futures/orders/cancel';
const PATH_POSITIONS = '/exchange/v1/derivatives/futures/positions';
const PATH_INSTRUMENT = '/exchange/v1/derivatives/futures/data/instrument';

export interface CoinDcxClientOptions {
  apiKey: string;
  apiSecret: string;
  apiBaseUrl: string;
  readOnly: boolean;
}

export class CoinDcxFuturesClient {
  private readonly http: AxiosInstance;

  constructor(private readonly opts: CoinDcxClientOptions) {
    this.http = axios.create({
      baseURL: opts.apiBaseUrl.replace(/\/$/, ''),
      timeout: 15_000,
      headers: { Accept: 'application/json' },
    });
  }

  private sign(payload: string): string {
    return crypto.createHmac('sha256', this.opts.apiSecret).update(payload).digest('hex');
  }

  private authHeaders(body: Record<string, unknown>): Record<string, string> {
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return {
      'Content-Type': 'application/json',
      'X-AUTH-APIKEY': this.opts.apiKey,
      'X-AUTH-SIGNATURE': this.sign(payload),
    };
  }

  private guardWrite(endpoint: string): void {
    if (this.opts.readOnly) {
      throw new Error(`Read-only violation: blocked write ${endpoint}`);
    }
  }

  private static isClockSkewError(error: unknown): boolean {
    const err = error as { response?: { status?: number; data?: { message?: string } } };
    const status = err?.response?.status;
    if (status !== 400 && status !== 401 && status !== 403) return false;
    const message = String(err?.response?.data?.message ?? '');
    return /(timestamp|clock|ahead|behind|expired|nonce|recvwindow)/i.test(message);
  }

  private static parseDateHeader(headers: unknown): number | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const raw =
      (headers as Record<string, unknown>)['date'] ??
      (headers as Record<string, unknown>)['Date'];
    if (typeof raw !== 'string') return undefined;
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private async fetchServerTimestamp(): Promise<number> {
    const response = await this.http.get('/exchange/v1/markets', { timeout: 5_000 });
    const serverMs = CoinDcxFuturesClient.parseDateHeader(response.headers);
    if (serverMs === undefined) throw new Error('Clock-sync failed: missing or invalid Date header');
    return serverMs;
  }

  private formatError(endpoint: string, error: unknown): Error {
    const err = error as { response?: { status?: number; data?: { message?: string } }; message?: string };
    const status = err?.response?.status;
    const msg = err?.response?.data?.message || err?.message;
    return new Error(`${endpoint} API [${status || 'timeout'}]: ${msg}`);
  }

  private async withClockSkewRetry<T>(
    endpoint: string,
    bodyBuilder: (timestamp: number) => Record<string, unknown>,
    execute: (req: { body: Record<string, unknown>; headers: Record<string, string> }) => Promise<T>,
  ): Promise<T> {
    const firstBody = bodyBuilder(Date.now());
    const first = { body: firstBody, headers: this.authHeaders(firstBody) };
    try {
      return await execute(first);
    } catch (error: unknown) {
      if (!CoinDcxFuturesClient.isClockSkewError(error)) {
        throw this.formatError(endpoint, error);
      }
      const err = error as { response?: { headers?: unknown } };
      const fromErr = CoinDcxFuturesClient.parseDateHeader(err?.response?.headers);
      const serverTs = fromErr ?? (await this.fetchServerTimestamp());
      const retryBody = bodyBuilder(serverTs);
      const retry = { body: retryBody, headers: this.authHeaders(retryBody) };
      try {
        return await execute(retry);
      } catch (retryErr: unknown) {
        throw this.formatError(endpoint, retryErr);
      }
    }
  }

  async getFuturesInstrumentDetails(instrument?: string): Promise<unknown> {
    const params = instrument?.trim() ? { instrument: instrument.trim() } : undefined;
    const { data } = await this.http.get(PATH_INSTRUMENT, { params });
    return data;
  }

  async getFuturesPositionByPair(pair: string): Promise<unknown> {
    const p = pair.trim();
    if (!p) throw new Error('getFuturesPositionByPair requires pair');
    return this.withClockSkewRetry(
      'FuturesPositionDetails',
      (timestamp) => ({
        timestamp,
        pair: p,
        pairs: [p],
      }),
      async ({ body, headers }) => {
        const { data } = await this.http.post(PATH_POSITIONS, body, { headers });
        return data;
      },
    );
  }

  async createFuturesOrder(order: Record<string, unknown>): Promise<unknown> {
    this.guardWrite('createFuturesOrder');
    return this.withClockSkewRetry(
      'FuturesCreateOrder',
      (timestamp) => ({ timestamp, ...order }),
      async ({ body, headers }) => {
        const { data } = await this.http.post(PATH_CREATE, body, { headers });
        return data;
      },
    );
  }

  async cancelFuturesOrder(orderId: string): Promise<unknown> {
    const id = orderId.trim();
    if (!id) throw new Error('cancelFuturesOrder requires orderId');
    this.guardWrite('cancelFuturesOrder');
    return this.withClockSkewRetry(
      'FuturesCancelOrder',
      (timestamp) => ({ timestamp, id }),
      async ({ body, headers }) => {
        const { data } = await this.http.post(PATH_CANCEL, body, { headers });
        return data;
      },
    );
  }
}
