import { FEATURE_KEYS, type FeatureVector } from './feature-schema';

interface RollingStats {
  count: number;
  mean: number;
  m2: number;
}

const WINSORIZE_SIGMA = 5;

export class FeatureNormalizer {
  private stats = new Map<string, RollingStats>();

  constructor(private readonly windowSize = 1000) {}

  normalize(fv: FeatureVector): FeatureVector {
    const out = { ...fv };
    for (const key of FEATURE_KEYS) {
      const raw = fv[key] as number;
      if (!Number.isFinite(raw)) {
        (out as Record<string, unknown>)[key] = 0;
        continue;
      }
      const stat = this.updateStats(key, raw);
      (out as Record<string, unknown>)[key] = this.zscore(stat, raw);
    }
    return out;
  }

  reset(): void {
    this.stats.clear();
  }

  private updateStats(key: string, value: number): RollingStats {
    let s = this.stats.get(key);
    if (!s) {
      s = { count: 0, mean: 0, m2: 0 };
      this.stats.set(key, s);
    }

    s.count += 1;

    if (s.count > this.windowSize) {
      const decay = 1 - 1 / this.windowSize;
      s.mean = s.mean * decay + value * (1 - decay);
      s.m2 = s.m2 * decay + (value - s.mean) ** 2 * (1 - decay);
    } else {
      const delta = value - s.mean;
      s.mean += delta / s.count;
      const delta2 = value - s.mean;
      s.m2 += delta * delta2;
    }

    return s;
  }

  private zscore(s: RollingStats, value: number): number {
    if (s.count < 2) return 0;
    const variance = s.count <= this.windowSize
      ? s.m2 / (s.count - 1)
      : s.m2;
    const std = Math.sqrt(variance);
    if (std < 1e-12) return 0;
    const z = (value - s.mean) / std;
    return Math.max(-WINSORIZE_SIGMA, Math.min(WINSORIZE_SIGMA, z));
  }
}
