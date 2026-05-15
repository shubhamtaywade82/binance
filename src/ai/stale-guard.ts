export type DataSource = 'depth' | 'trade' | 'markPrice';

const DEFAULT_MAX_AGE_MS = 500;

export class StaleGuard {
  private readonly lastUpdate = new Map<string, number>();
  private readonly defaultMaxAgeMs: number;

  constructor(
    sources: DataSource[] = ['depth', 'trade', 'markPrice'],
    defaultMaxAgeMs = DEFAULT_MAX_AGE_MS,
  ) {
    this.defaultMaxAgeMs = defaultMaxAgeMs;
    for (const src of sources) {
      this.lastUpdate.set(src, 0);
    }
  }

  markFresh(source: string): void {
    this.lastUpdate.set(source, Date.now());
  }

  isStale(source: string, maxAgeMs?: number): boolean {
    const last = this.lastUpdate.get(source);
    if (last === undefined || last === 0) return true;
    return Date.now() - last > (maxAgeMs ?? this.defaultMaxAgeMs);
  }

  anyStale(): boolean {
    for (const source of this.lastUpdate.keys()) {
      if (this.isStale(source)) return true;
    }
    return false;
  }

  staleSources(): string[] {
    const stale: string[] = [];
    for (const source of this.lastUpdate.keys()) {
      if (this.isStale(source)) stale.push(source);
    }
    return stale;
  }
}
