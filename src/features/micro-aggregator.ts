export interface MicroAggregate {
  mean: number;
  max: number;
  min: number;
  last: number;
  count: number;
  sum: number;
}

interface TimedSample {
  value: number;
  ts: number;
}

export class MicroAggregator {
  private readonly windowMs: number;
  private samples: TimedSample[] = [];

  constructor(windowMs: number) {
    if (windowMs <= 0) throw new Error('windowMs must be positive');
    this.windowMs = windowMs;
  }

  push(value: number, ts: number = Date.now()): void {
    this.samples.push({ value, ts });
    this.evict(ts);
  }

  snapshot(): MicroAggregate {
    if (this.samples.length === 0) {
      return { mean: 0, max: 0, min: 0, last: 0, count: 0, sum: 0 };
    }

    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    let last = 0;

    for (const s of this.samples) {
      sum += s.value;
      if (s.value > max) max = s.value;
      if (s.value < min) min = s.value;
      last = s.value;
    }

    return {
      mean: sum / this.samples.length,
      max,
      min,
      last,
      count: this.samples.length,
      sum,
    };
  }

  reset(): void {
    this.samples = [];
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i].ts < cutoff) i++;
    if (i > 0) this.samples.splice(0, i);
  }
}
