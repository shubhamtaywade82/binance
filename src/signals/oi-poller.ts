import type { BinanceRestClient } from '../binance/rest-client';
import { getOpenInterest } from '../binance/rest-trade';

export type PriceOiRegime =
  | 'price_up_oi_up'
  | 'price_up_oi_down'
  | 'price_down_oi_up'
  | 'price_down_oi_down'
  | 'neutral';

export interface OiSnapshot {
  oi: number;
  oiDelta1m: number;
  oiZscore: number;
  regime: PriceOiRegime;
}

export class OiPoller {
  private history: number[] = [];
  private prevPrice = 0;
  private currentPrice = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: BinanceRestClient,
    private readonly symbol: string,
    private readonly intervalSec: number,
    private readonly windowSize: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.intervalSec * 1000);
    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  updatePrice(price: number): void {
    this.prevPrice = this.currentPrice;
    this.currentPrice = price;
  }

  private async poll(): Promise<void> {
    try {
      const res = await getOpenInterest(this.client, this.symbol);
      const oi = parseFloat(res.openInterest);
      if (!Number.isFinite(oi)) return;
      this.history.push(oi);
      if (this.history.length > this.windowSize) {
        this.history = this.history.slice(-this.windowSize);
      }
    } catch {
      // Swallow — poll will retry on next interval.
    }
  }

  snapshot(): OiSnapshot {
    const len = this.history.length;
    if (len < 2) return { oi: this.history[len - 1] ?? 0, oiDelta1m: 0, oiZscore: 0, regime: 'neutral' };

    const current = this.history[len - 1];
    const samplesPerMin = Math.max(1, Math.round(60 / this.intervalSec));
    const prev = this.history[Math.max(0, len - 1 - samplesPerMin)];
    const oiDelta1m = current - prev;

    const deltas = this.computeDeltas();
    const oiZscore = this.zscore(deltas, oiDelta1m);

    return { oi: current, oiDelta1m, oiZscore, regime: this.classify(oiDelta1m) };
  }

  private computeDeltas(): number[] {
    const d: number[] = [];
    for (let i = 1; i < this.history.length; i++) {
      d.push(this.history[i] - this.history[i - 1]);
    }
    return d;
  }

  private zscore(deltas: number[], value: number): number {
    if (deltas.length < 2) return 0;
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / deltas.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (value - mean) / std;
  }

  private classify(oiDelta: number): PriceOiRegime {
    if (this.prevPrice <= 0 || this.currentPrice <= 0) return 'neutral';
    const priceUp = this.currentPrice > this.prevPrice;
    const priceDown = this.currentPrice < this.prevPrice;
    const oiUp = oiDelta > 0;
    const oiDown = oiDelta < 0;

    if (priceUp && oiUp) return 'price_up_oi_up';
    if (priceUp && oiDown) return 'price_up_oi_down';
    if (priceDown && oiUp) return 'price_down_oi_up';
    if (priceDown && oiDown) return 'price_down_oi_down';
    return 'neutral';
  }
}
