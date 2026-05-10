import axios, { type AxiosInstance } from 'axios';

export interface FundingPosition {
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  notional: () => number;
}

export interface PremiumIndexResponse {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

export interface FundingEngineOptions {
  binanceRestBase: string;
  pollSec: number;
  http?: AxiosInstance;
  now?: () => number;
}

export class FundingEngine {
  private readonly http: AxiosInstance;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private rateBySymbol = new Map<string, { rate: number; nextTime: number }>();
  private accrued = new Map<string, number>();
  private chargedFundingTime = new Map<string, number>();
  private positions = new Map<string, FundingPosition>();
  private symbols = new Set<string>();

  constructor(private readonly opts: FundingEngineOptions) {
    this.http = opts.http ?? axios.create({ baseURL: opts.binanceRestBase, timeout: 10_000 });
    this.now = opts.now ?? (() => Date.now());
  }

  trackSymbol(symbol: string): void {
    this.symbols.add(symbol.toUpperCase());
  }

  trackPosition(p: FundingPosition): void {
    this.positions.set(p.positionId, p);
    this.trackSymbol(p.symbol);
    this.accrued.set(p.positionId, 0);
  }

  untrackPosition(positionId: string): void {
    this.positions.delete(positionId);
    this.accrued.delete(positionId);
    this.chargedFundingTime.delete(positionId);
  }

  accruedFor(positionId: string): number {
    return this.accrued.get(positionId) ?? 0;
  }

  start(): void {
    if (this.timer) return;
    const ms = Math.max(1000, this.opts.pollSec * 1000);
    this.timer = setInterval(() => void this.tick().catch(() => undefined), ms);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    await this.refreshRates();
    this.applyFundingIfDue();
  }

  async refreshRates(): Promise<void> {
    for (const sym of this.symbols) {
      try {
        const { data } = await this.http.get<PremiumIndexResponse>('/fapi/v1/premiumIndex', {
          params: { symbol: sym },
        });
        const rate = Number(data.lastFundingRate);
        const nextTime = Number(data.nextFundingTime);
        if (Number.isFinite(rate) && Number.isFinite(nextTime)) {
          this.rateBySymbol.set(sym, { rate, nextTime });
        }
      } catch {
        // ignore transient failures
      }
    }
  }

  /** Public for tests. Charges funding for positions whose nextFundingTime has been crossed. */
  applyFundingIfDue(): void {
    const t = this.now();
    for (const pos of this.positions.values()) {
      const r = this.rateBySymbol.get(pos.symbol.toUpperCase());
      if (!r) continue;
      if (t < r.nextTime) continue;
      if (this.chargedFundingTime.get(pos.positionId) === r.nextTime) continue;
      const notional = pos.notional();
      const sideMul = pos.side === 'LONG' ? 1 : -1;
      const fundingUsdt = notional * r.rate * sideMul;
      this.accrued.set(pos.positionId, (this.accrued.get(pos.positionId) ?? 0) + fundingUsdt);
      this.chargedFundingTime.set(pos.positionId, r.nextTime);
    }
  }

  /** Test helper: inject rate without HTTP. */
  setRateForSymbol(symbol: string, rate: number, nextTime: number): void {
    this.rateBySymbol.set(symbol.toUpperCase(), { rate, nextTime });
  }
}
