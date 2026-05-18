/**
 * Live INR/USDT FX rate poller.
 *
 * Sources:
 *   - `binance`  → https://api.binance.com/api/v3/ticker/price?symbol=USDTINR
 *                  (falls back to BUSDINR if USDTINR returns an error/no price)
 *   - `coindcx`  → https://api.coindcx.com/exchange/ticker  (find market === USDTINR, use last_price)
 *   - `fixed`    → no polling; always returns the static `fallbackInrPerUsdt`.
 *
 * On any fetch error the last known rate is kept. If the very first fetch fails
 * the service returns `fallbackInrPerUsdt` until a successful poll arrives.
 */

export type FxRateSource = 'binance' | 'coindcx' | 'fixed';

export interface FxRateSnapshot {
  rate: number;
  source: FxRateSource;
  fetchedAt: number;
  /** True when no successful fetch has occurred yet (using fallback). */
  stale: boolean;
}

export interface FxRateOptions {
  source: FxRateSource;
  refreshSec: number;
  fallbackInrPerUsdt: number;
  /** Override fetch (testing). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /**
   * M-17: how old a successful fetch is allowed to be before getInrPerUsdt()
   * starts reporting `stale=true` again. Callers that convert PnL into INR
   * MUST check the snapshot's `stale` flag and refuse to display / persist
   * a converted value when stale. Default 10 min — generous enough to ride
   * out a CoinDCX/Binance API blip but short enough that operator-facing
   * dashboards never quote a stale conversion. Override via env to suit
   * your tolerance (e.g. tighter on live).
   */
  maxAgeMs?: number;
}

const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price';
const COINDCX_TICKER_URL = 'https://api.coindcx.com/exchange/ticker';

interface BinanceTickerPrice {
  symbol: string;
  price: string;
}

interface CoinDcxTickerRow {
  market: string;
  last_price: string;
}

const parsePositive = (v: string | number | undefined): number | null => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export class FxRateService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private rate: number;
  private fetchedAt = 0;
  private stale = true;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAgeMs: number;
  private startInflight: Promise<void> | null = null;

  constructor(private readonly opts: FxRateOptions) {
    this.rate = opts.fallbackInrPerUsdt;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
  }

  /**
   * M-17: returns true when the cached rate is older than maxAgeMs OR no
   * successful fetch has happened yet (initial-fallback case). Callers that
   * convert USDT → INR for operator-facing display or PnL persistence MUST
   * check this flag and either refuse to convert or annotate the output as
   * "stale FX". The previous getInrPerUsdt() silently returned the
   * possibly-hours-old rate.
   */
  isRateStale(now: number = Date.now()): boolean {
    if (this.opts.source === 'fixed') return false;
    if (this.stale) return true;
    return now - this.fetchedAt > this.maxAgeMs;
  }

  /**
   * Starts the poller. Performs one synchronous-ish initial fetch (5s timeout) and
   * schedules periodic refreshes. Returns the kick-off promise so callers can await
   * the initial value if they want; awaiting is optional.
   */
  start(): Promise<void> {
    if (this.opts.source === 'fixed') {
      this.stale = false;
      this.fetchedAt = Date.now();
      return Promise.resolve();
    }
    if (this.startInflight) return this.startInflight;
    this.startInflight = this.refreshOnce().catch(() => undefined);
    const sec = Math.max(15, this.opts.refreshSec);
    this.timer = setInterval(() => {
      void this.refreshOnce().catch(() => undefined);
    }, sec * 1000);
    return this.startInflight;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getInrPerUsdt(): number {
    return this.rate;
  }

  snapshot(): FxRateSnapshot {
    return {
      rate: this.rate,
      source: this.opts.source,
      fetchedAt: this.fetchedAt,
      // M-17: `stale` now reflects BOTH "never successfully fetched" AND
      // "fetched but older than maxAgeMs". Existing consumers that already
      // honor this flag automatically pick up the ceiling.
      stale: this.isRateStale(),
    };
  }

  /** Public for testability. */
  async refreshOnce(): Promise<void> {
    try {
      let next: number | null = null;
      if (this.opts.source === 'binance') {
        next = await this.fetchBinance();
      } else if (this.opts.source === 'coindcx') {
        next = await this.fetchCoinDcx();
      }
      if (next !== null) {
        this.rate = next;
        this.fetchedAt = Date.now();
        this.stale = false;
      }
    } catch {
      // Keep last value on transport / parse error.
    }
  }

  private async fetchBinance(): Promise<number | null> {
    const primary = await this.binanceSymbol('USDTINR');
    if (primary !== null) return primary;
    return this.binanceSymbol('BUSDINR');
  }

  private async binanceSymbol(symbol: string): Promise<number | null> {
    const res = await this.fetchWithTimeout(`${BINANCE_URL}?symbol=${symbol}`);
    if (!res || !res.ok) return null;
    const j = (await res.json()) as BinanceTickerPrice | { code?: number; msg?: string };
    if ('price' in j) return parsePositive(j.price);
    return null;
  }

  private async fetchCoinDcx(): Promise<number | null> {
    const res = await this.fetchWithTimeout(COINDCX_TICKER_URL);
    if (!res || !res.ok) return null;
    const rows = (await res.json()) as CoinDcxTickerRow[];
    if (!Array.isArray(rows)) return null;
    const row = rows.find((r) => r?.market === 'USDTINR');
    return row ? parsePositive(row.last_price) : null;
  }

  private async fetchWithTimeout(url: string): Promise<Response | null> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: ctrl.signal });
    } catch {
      return null;
    } finally {
      clearTimeout(to);
    }
  }
}
