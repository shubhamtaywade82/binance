import type { BinanceRestClient } from '../binance/rest-client';
import { getOpenInterest } from '../binance/rest-trade';

interface OiSample {
  ts: number;
  oi: number;
}

const DEFAULT_POLL_INTERVAL_MS = 7_000;
const MAX_SAMPLES = 360;

export class OiPollIntegrator {
  private readonly samples: OiSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly client: BinanceRestClient,
    private readonly symbol: string,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.pollIntervalMs = Math.max(5_000, Math.min(10_000, pollIntervalMs));
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  interpolateAt(ts: number): number {
    const len = this.samples.length;
    if (len === 0) return 0;
    if (len === 1) return this.samples[0].oi;

    if (ts <= this.samples[0].ts) return this.samples[0].oi;
    if (ts >= this.samples[len - 1].ts) return this.samples[len - 1].oi;

    for (let i = 1; i < len; i++) {
      const prev = this.samples[i - 1];
      const curr = this.samples[i];
      if (ts >= prev.ts && ts <= curr.ts) {
        const span = curr.ts - prev.ts;
        if (span === 0) return curr.oi;
        const t = (ts - prev.ts) / span;
        return prev.oi + t * (curr.oi - prev.oi);
      }
    }

    return this.samples[len - 1].oi;
  }

  latestDelta(windowSec: number): number {
    const len = this.samples.length;
    if (len < 2) return 0;

    const latest = this.samples[len - 1];
    const cutoff = latest.ts - windowSec * 1000;
    const start = this.interpolateAt(cutoff);
    return latest.oi - start;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  private async poll(): Promise<void> {
    try {
      const res = await getOpenInterest(this.client, this.symbol);
      const oi = parseFloat(res.openInterest);
      if (!Number.isFinite(oi)) return;

      this.samples.push({ ts: Date.now(), oi });
      if (this.samples.length > MAX_SAMPLES) {
        this.samples.splice(0, this.samples.length - MAX_SAMPLES);
      }
    } catch {
      // Poll will retry on next interval.
    }
  }
}
