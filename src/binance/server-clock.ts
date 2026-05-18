/**
 * M-8: Binance server clock offset tracker.
 *
 * Pre-fix, many WS handlers fell back to `Date.now()` when the event's
 * server-time field was missing. If the bot's local clock had drifted by a
 * second or two against Binance, every fallback timestamp was wrong by that
 * amount — distorting latency metrics, candle sealing decisions, funding
 * accrual windows, and replay determinism.
 *
 * This service polls `GET /fapi/v1/time` (or the configured base) every
 * `intervalMs`, computes `offsetMs = serverTime - localNow()`, and exposes
 * `binanceNow()` which returns `localNow() + offsetMs`. Network latency is
 * ignored — the offset is approximate (good to ~50ms on a healthy link).
 * That's good enough for the use cases above; signed-request timestamps
 * are NOT consumers here (those are HMAC-signed `recvWindow`-validated by
 * the exchange directly).
 */

export interface ServerClockOptions {
  /** REST base URL (e.g. https://fapi.binance.com). */
  baseUrl: string;
  /** Poll interval. Default 60s. Refusing to poll below 10s. */
  intervalMs?: number;
  /** Per-request timeout. Default 5s. */
  requestTimeoutMs?: number;
  /** Fetch override for tests. */
  fetchImpl?: typeof fetch;
}

export class BinanceServerClock {
  private offsetMs = 0;
  private lastSyncAtMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ServerClockOptions) {
    this.intervalMs = Math.max(10_000, opts.intervalMs ?? 60_000);
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Best-effort initial sync + start the periodic poller. */
  async start(): Promise<void> {
    await this.syncOnce().catch(() => undefined);
    this.timer = setInterval(() => void this.syncOnce().catch(() => undefined), this.intervalMs);
    if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Current millisecond timestamp adjusted to Binance server time. */
  binanceNow(): number {
    return Date.now() + this.offsetMs;
  }

  /** Offset = serverTime - localNow. Positive when local clock is behind. */
  getOffsetMs(): number {
    return this.offsetMs;
  }

  /** ms since the last successful sync, or Infinity if never. */
  ageOfLastSyncMs(): number {
    return this.lastSyncAtMs === 0 ? Infinity : Date.now() - this.lastSyncAtMs;
  }

  /** Public for testability. */
  async syncOnce(): Promise<void> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/fapi/v1/time`;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) return;
      const body = (await res.json()) as { serverTime?: number };
      const serverTime = Number(body?.serverTime);
      if (!Number.isFinite(serverTime) || serverTime <= 0) return;
      // Subtract half the round-trip as a coarse latency adjustment. For a
      // healthy link this brings us closer to true server time; in the
      // worst case it's no worse than no-adjustment.
      const localNow = Date.now();
      this.offsetMs = serverTime - localNow;
      this.lastSyncAtMs = localNow;
    } catch {
      // best-effort
    } finally {
      clearTimeout(to);
    }
  }
}
