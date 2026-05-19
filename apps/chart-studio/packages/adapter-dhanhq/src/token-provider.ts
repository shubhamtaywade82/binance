import axios, { type AxiosInstance } from 'axios';

export interface DhanCreds {
  clientId: string;
  accessToken: string;
}

export interface TokenProvider {
  /** Resolve a fresh set of creds. Implementations may cache internally. */
  get(): Promise<DhanCreds>;
  /** Force a refresh on next call (e.g. after a 401). */
  invalidate(): void;
  /** Cleanup any timers/connections. */
  shutdown(): void;
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly creds: DhanCreds) {}
  async get(): Promise<DhanCreds> { return this.creds; }
  invalidate(): void { /* no-op */ }
  shutdown(): void { /* no-op */ }
}

export interface AlgoScalperResponse {
  client_id?: string;
  clientId?: string;
  access_token?: string;
  accessToken?: string;
  /** Unix ms or seconds; we accept either. */
  expires_at?: number;
  expiresAt?: number;
}

/**
 * Polls a local algo_scalper_api token endpoint for rotated Dhan creds.
 * Default contract: GET <url> -> { client_id, access_token, expires_at }.
 * Refreshes proactively before expiry, on demand, and on invalidate().
 */
export class AlgoScalperTokenProvider implements TokenProvider {
  private cached: { creds: DhanCreds; expiresAt: number } | null = null;
  private inflight: Promise<DhanCreds> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly http: AxiosInstance;

  constructor(
    private readonly url: string,
    private readonly opts: {
      apiKey?: string;
      /** Minimum refresh interval safety net (default 5 min). */
      minRefreshMs?: number;
      /** Buffer before expiry to refresh (default 60s). */
      preExpiryMs?: number;
    } = {},
  ) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.apiKey) headers['X-API-Key'] = opts.apiKey;
    this.http = axios.create({ timeout: 10_000, headers });
  }

  async get(): Promise<DhanCreds> {
    if (this.cached && Date.now() < this.cached.expiresAt - (this.opts.preExpiryMs ?? 60_000)) {
      return this.cached.creds;
    }
    return this.refresh();
  }

  invalidate(): void {
    this.cached = null;
  }

  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async refresh(): Promise<DhanCreds> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const { data } = await this.http.get<AlgoScalperResponse>(this.url);
        const clientId = data.client_id ?? data.clientId;
        const accessToken = data.access_token ?? data.accessToken;
        if (!clientId || !accessToken) throw new Error('algo_scalper_api response missing client_id / access_token');
        let expiresAt = data.expires_at ?? data.expiresAt;
        // Accept seconds or ms; assume seconds if < 1e12.
        if (typeof expiresAt === 'number' && expiresAt > 0 && expiresAt < 1e12) expiresAt *= 1000;
        const creds: DhanCreds = { clientId, accessToken };
        const safeExpiry = typeof expiresAt === 'number' && expiresAt > Date.now() ? expiresAt : Date.now() + (this.opts.minRefreshMs ?? 5 * 60_000);
        this.cached = { creds, expiresAt: safeExpiry };
        this.scheduleNextRefresh(safeExpiry);
        return creds;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private scheduleNextRefresh(expiresAt: number): void {
    if (this.timer) clearTimeout(this.timer);
    const buffer = this.opts.preExpiryMs ?? 60_000;
    const minMs = this.opts.minRefreshMs ?? 60_000;
    const delay = Math.max(minMs, expiresAt - Date.now() - buffer);
    this.timer = setTimeout(() => {
      this.refresh().catch((err) => console.error('[algo_scalper_api] refresh failed', err));
    }, delay);
  }
}
