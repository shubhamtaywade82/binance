import { randomUUID } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import WebSocket from 'ws';
import {
  buildSignedPayloadString,
  loadEd25519PrivateKeyFromPem,
  signPayloadEd25519Base64,
} from './futures-ws-sign';

export interface FuturesWsApiUrlOptions {
  /** Full URL including `/ws-fapi/v1`. Overrides testnet/mainnet defaults. */
  explicitUrl?: string;
  useTestnet: boolean;
  /** Query param on handshake, e.g. `returnRateLimits=false`. */
  returnRateLimits?: boolean;
}

export const futuresWsApiUrl = (opts: FuturesWsApiUrlOptions): string => {
  if (opts.explicitUrl?.trim()) return opts.explicitUrl.trim();
  const base = opts.useTestnet
    ? 'wss://testnet.binancefuture.com/ws-fapi/v1'
    : 'wss://ws-fapi.binance.com/ws-fapi/v1';
  if (opts.returnRateLimits === false) return `${base}?returnRateLimits=false`;
  return base;
}

export const futuresWsApiUrlFromConfig = (opts: {
  explicitUrl?: string;
  useTestnet: boolean;
  hideRateLimits: boolean;
}): string => {
  return futuresWsApiUrl({
    explicitUrl: opts.explicitUrl,
    useTestnet: opts.useTestnet,
    returnRateLimits: opts.hideRateLimits ? false : undefined,
  });
}

export interface FuturesWsApiClientOptions {
  url: string;
  apiKey: string;
  privateKey: KeyObject;
  /** Override WebSocket (tests). */
  wsFactory?: (url: string) => WebSocket;
  requestTimeoutMs?: number;
}

export interface WsApiJsonResponse<T = unknown> {
  id: string | number | null;
  status: number;
  result?: T;
  error?: { code: number; msg: string };
  rateLimits?: unknown[];
}

export class FuturesWsApiError extends Error {
  constructor(
    readonly raw: WsApiJsonResponse,
    message?: string,
  ) {
    super(message ?? raw.error?.msg ?? `WebSocket API status ${raw.status}`);
    this.name = 'FuturesWsApiError';
  }

  get code(): number | undefined {
    return this.raw.error?.code;
  }
}

type Pending = {
  resolve: (v: WsApiJsonResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Binance USD-M **trading** WebSocket API (`ws-fapi`): `session.logon`, `order.place`, etc.
 * Market data uses `fstream` separately (`BinanceMultiplexWs`).
 *
 * Ping frames every ~3 minutes — native `ws` answers with mirrored pong (same payload).
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-api-general-info
 */
export class BinanceFuturesWsApiClient {
  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private sessionAuthenticated = false;

  constructor(private readonly opts: FuturesWsApiClientOptions) {}

  get isSessionAuthenticated(): boolean {
    return this.sessionAuthenticated;
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    const socket = factory(this.opts.url);

    socket.on('ping', (payload: Buffer) => {
      try {
        socket.pong(payload);
      } catch {
        // ignore
      }
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString();
        const msg = JSON.parse(text) as WsApiJsonResponse;
        this.dispatchResponse(msg);
      } catch {
        // ignore malformed frames
      }
    });

    socket.on('close', () => {
      this.ws = null;
      this.rejectAllPending(new Error('WebSocket closed'));
    });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off('error', onErr);
        resolve();
      };
      const onErr = (e: Error) => {
        socket.off('open', onOpen);
        reject(e);
      };
      socket.once('open', onOpen);
      socket.once('error', onErr);
    });

    this.ws = socket;
  }

  async disconnect(): Promise<void> {
    this.sessionAuthenticated = false;
    if (!this.ws) return;
    const s = this.ws;
    this.ws = null;
    s.removeAllListeners();
    try {
      s.close(1000, 'client_shutdown');
    } catch {
      // ignore
    }
    this.rejectAllPending(new Error('WebSocket disconnected'));
  }

  /** `session.logon` — authenticates the connection for subsequent signed-less requests. */
  async logon(extra?: { recvWindow?: number }): Promise<WsApiJsonResponse<{ serverTime: number }>> {
    const timestamp = Date.now();
    const params: Record<string, string | number> = {
      apiKey: this.opts.apiKey,
      timestamp,
    };
    if (extra?.recvWindow !== undefined) params.recvWindow = extra.recvWindow;
    const payload = buildSignedPayloadString(params);
    const signature = signPayloadEd25519Base64(payload, this.opts.privateKey);
    const res = await this.request('session.logon', {
      ...params,
      signature,
    });
    if (res.status === 200) this.sessionAuthenticated = true;
    return res as WsApiJsonResponse<{ serverTime: number }>;
  }

  async sessionStatus(): Promise<WsApiJsonResponse> {
    return this.request('session.status', {});
  }

  async logout(): Promise<WsApiJsonResponse> {
    const res = await this.request('session.logout', {});
    if (res.status === 200) this.sessionAuthenticated = false;
    return res;
  }

  /**
   * Place order. After successful `logon()`, omit signing — Binance uses the session key.
   * Without session, pass full signed params (apiKey, timestamp, signature) yourself or call `logon` first.
   */
  async orderPlace(
    orderParams: Record<string, string | number>,
  ): Promise<WsApiJsonResponse<Record<string, unknown>>> {
    if (!this.sessionAuthenticated) {
      const signed = this.signParams({
        ...orderParams,
        apiKey: this.opts.apiKey,
        timestamp: Date.now(),
      });
      return this.request('order.place', signed);
    }
    return this.request('order.place', orderParams);
  }

  /**
   * Modify an existing order via WS API — avoids REST round-trip.
   * Only `quantity` and `price` can be changed.
   */
  async orderModify(
    orderParams: Record<string, string | number>,
  ): Promise<WsApiJsonResponse<Record<string, unknown>>> {
    if (!this.sessionAuthenticated) {
      const signed = this.signParams({
        ...orderParams,
        apiKey: this.opts.apiKey,
        timestamp: Date.now(),
      });
      return this.request('order.modify', signed);
    }
    return this.request('order.modify', orderParams);
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, string | number | boolean> = {},
  ): Promise<WsApiJsonResponse<T>> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    const id = randomUUID();
    const body = JSON.stringify({ id, method, params });
    const timeoutMs = this.opts.requestTimeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WebSocket API timeout after ${timeoutMs}ms (${method})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => resolve(v as WsApiJsonResponse<T>),
        reject,
        timer,
      });
      try {
        ws.send(body);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private signParams(params: Record<string, string | number>): Record<string, string | number> {
    const copy = { ...params };
    const payload = buildSignedPayloadString(copy);
    const signature = signPayloadEd25519Base64(payload, this.opts.privateKey);
    return { ...copy, signature };
  }

  private dispatchResponse(msg: WsApiJsonResponse): void {
    if (msg.id !== null && msg.id !== undefined && this.pending.has(String(msg.id))) {
      const id = String(msg.id);
      const p = this.pending.get(id)!;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (msg.status === 200) {
        p.resolve(msg);
      } else {
        p.reject(new FuturesWsApiError(msg));
      }
      return;
    }

    if (msg.status === 401 && msg.error?.code === -2015) {
      this.sessionAuthenticated = false;
      this.rejectAllPending(new FuturesWsApiError(msg));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

export const createFuturesWsApiClientFromPem = (options: {
  url: string;
  apiKey: string;
  ed25519PrivateKeyPem: string;
  wsFactory?: (url: string) => WebSocket;
  requestTimeoutMs?: number;
}): BinanceFuturesWsApiClient => {
  const privateKey = loadEd25519PrivateKeyFromPem(options.ed25519PrivateKeyPem);
  return new BinanceFuturesWsApiClient({
    url: options.url,
    apiKey: options.apiKey,
    privateKey,
    wsFactory: options.wsFactory,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}
