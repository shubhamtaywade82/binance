export interface FundingSnapshot {
  currentRate: number;
  zscore: number;
  extremeFlag: boolean;
  /** Positive = longs paying (crowded long), negative = shorts paying (crowded short). */
  crowdedSide: 'LONG' | 'SHORT' | 'NEUTRAL';
}

export class FundingTracker {
  private rates: number[] = [];
  private currentRate = 0;

  constructor(
    private readonly windowSize = 480,
    private readonly extremeStdThreshold = 2,
  ) {}

  /**
   * Called on each `@markPrice@1s` event which includes the current funding rate.
   * Binance markPrice stream provides `r` (funding rate) in the payload.
   */
  update(fundingRate: number): void {
    this.currentRate = fundingRate;
    this.rates.push(fundingRate);
    if (this.rates.length > this.windowSize) {
      this.rates = this.rates.slice(-this.windowSize);
    }
  }

  snapshot(): FundingSnapshot {
    if (this.rates.length < 2) {
      return { currentRate: this.currentRate, zscore: 0, extremeFlag: false, crowdedSide: 'NEUTRAL' };
    }

    const mean = this.rates.reduce((a, b) => a + b, 0) / this.rates.length;
    const variance = this.rates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / this.rates.length;
    const std = Math.sqrt(variance);
    const zscore = std > 0 ? (this.currentRate - mean) / std : 0;
    const extremeFlag = Math.abs(zscore) > this.extremeStdThreshold;

    let crowdedSide: FundingSnapshot['crowdedSide'] = 'NEUTRAL';
    if (extremeFlag) {
      crowdedSide = this.currentRate > 0 ? 'LONG' : 'SHORT';
    }

    return { currentRate: this.currentRate, zscore, extremeFlag, crowdedSide };
  }
}
