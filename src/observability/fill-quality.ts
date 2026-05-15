export interface FillQualityRecord {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  refPrice: number;
  fillPrice: number;
  slippageBps: number;
  timestamp: number;
}

export interface FillQualityReport {
  totalFills: number;
  meanSlippageBps: number;
  medianSlippageBps: number;
  stdSlippageBps: number;
  worstSlippageBps: number;
  bestSlippageBps: number;
}

type FillInput = Omit<FillQualityRecord, 'slippageBps'>;

export class FillQualityTracker {
  private readonly maxRecords: number;
  private readonly records: FillQualityRecord[] = [];

  constructor(maxRecords = 1000) {
    this.maxRecords = maxRecords;
  }

  record(fill: FillInput): void {
    if (fill.refPrice === 0) return;

    const sign = fill.side === 'BUY' ? 1 : -1;
    const slippageBps = sign * ((fill.fillPrice - fill.refPrice) / fill.refPrice) * 10_000;

    this.records.push({ ...fill, slippageBps });
    if (this.records.length > this.maxRecords) this.records.shift();
  }

  report(): FillQualityReport {
    if (this.records.length === 0) {
      return {
        totalFills: 0,
        meanSlippageBps: 0,
        medianSlippageBps: 0,
        stdSlippageBps: 0,
        worstSlippageBps: 0,
        bestSlippageBps: 0,
      };
    }

    const slippages = this.records.map(r => r.slippageBps);
    const sorted = [...slippages].sort((a, b) => a - b);
    const sum = slippages.reduce((a, b) => a + b, 0);
    const mean = sum / slippages.length;

    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];

    let sumSq = 0;
    for (const s of slippages) sumSq += (s - mean) ** 2;
    const std = slippages.length < 2 ? 0 : Math.sqrt(sumSq / (slippages.length - 1));

    return {
      totalFills: slippages.length,
      meanSlippageBps: mean,
      medianSlippageBps: median,
      stdSlippageBps: std,
      worstSlippageBps: sorted[sorted.length - 1],
      bestSlippageBps: sorted[0],
    };
  }

  recentRecords(n = 10): FillQualityRecord[] {
    return this.records.slice(-n);
  }
}
