import { RollingFeatureRing } from './rolling-feature-ring';

export class MinMaxNormalizer {
  private readonly windowSize: number;
  private readonly rings = new Map<string, RollingFeatureRing>();

  constructor(windowSize = 1000) {
    if (windowSize <= 0) throw new Error('windowSize must be positive');
    this.windowSize = windowSize;
  }

  normalize(key: string, value: number): number {
    let ring = this.rings.get(key);
    if (!ring) {
      ring = new RollingFeatureRing(this.windowSize);
      this.rings.set(key, ring);
    }

    ring.push(value);

    const lo = ring.min();
    const hi = ring.max();
    const range = hi - lo;
    if (range < 1e-12) return 0;
    return (value - lo) / range;
  }

  reset(): void {
    this.rings.clear();
  }
}
