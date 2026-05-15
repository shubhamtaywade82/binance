export interface ModelMetricsSnapshot {
  predictionCount: number;
  avgPUp: number;
  avgPDown: number;
  avgPFlat: number;
  aboveThresholdPct: number;
  liveAccuracy: number;
  featureDriftFlags: string[];
}

interface FeatureRunningStats {
  count: number;
  mean: number;
  m2: number;
  lastValue: number;
}

const DRIFT_SIGMA = 3;

export class ModelMetricsTracker {
  private readonly threshold: number;

  private predictionCount = 0;
  private sumPUp = 0;
  private sumPDown = 0;
  private sumPFlat = 0;
  private aboveThresholdCount = 0;

  private correctPredictions = 0;
  private totalOutcomes = 0;

  private readonly featureStats = new Map<string, FeatureRunningStats>();

  constructor(threshold = 0.65) {
    this.threshold = threshold;
  }

  recordPrediction(pUp: number, pDown: number, pFlat: number): void {
    this.predictionCount++;
    this.sumPUp += pUp;
    this.sumPDown += pDown;
    this.sumPFlat += pFlat;

    if (Math.max(pUp, pDown) > this.threshold) {
      this.aboveThresholdCount++;
    }
  }

  recordOutcome(predictedDirection: 1 | -1, actualDirection: 1 | -1 | 0): void {
    this.totalOutcomes++;
    if (predictedDirection === actualDirection) {
      this.correctPredictions++;
    }
  }

  recordFeatureStats(featureName: string, value: number): void {
    let stats = this.featureStats.get(featureName);
    if (!stats) {
      stats = { count: 0, mean: 0, m2: 0, lastValue: value };
      this.featureStats.set(featureName, stats);
    }

    stats.count++;
    const delta = value - stats.mean;
    stats.mean += delta / stats.count;
    const delta2 = value - stats.mean;
    stats.m2 += delta * delta2;
    stats.lastValue = value;
  }

  snapshot(): ModelMetricsSnapshot {
    const n = this.predictionCount;

    return {
      predictionCount: n,
      avgPUp: n > 0 ? this.sumPUp / n : 0,
      avgPDown: n > 0 ? this.sumPDown / n : 0,
      avgPFlat: n > 0 ? this.sumPFlat / n : 0,
      aboveThresholdPct: n > 0 ? this.aboveThresholdCount / n : 0,
      liveAccuracy: this.totalOutcomes > 0 ? this.correctPredictions / this.totalOutcomes : 0,
      featureDriftFlags: this.computeDriftFlags(),
    };
  }

  private computeDriftFlags(): string[] {
    const flags: string[] = [];

    for (const [name, stats] of this.featureStats) {
      if (stats.count < 3) continue;

      const variance = stats.m2 / (stats.count - 1);
      const std = Math.sqrt(variance);
      if (std === 0) continue;

      const deviation = Math.abs(stats.lastValue - stats.mean);
      if (deviation > DRIFT_SIGMA * std) {
        flags.push(name);
      }
    }

    return flags;
  }
}
