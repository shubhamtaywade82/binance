export interface SymbolFeatureSnapshot {
  symbol: string;
  timestamp: number;
  features: Record<string, number>;
}

export class FeatureBus {
  private readonly store = new Map<string, SymbolFeatureSnapshot>();

  update(symbol: string, features: Record<string, number>): void {
    this.store.set(symbol, {
      symbol,
      timestamp: Date.now(),
      features: { ...features },
    });
  }

  snapshot(symbol: string): SymbolFeatureSnapshot | null {
    return this.store.get(symbol) ?? null;
  }

  allSnapshots(): SymbolFeatureSnapshot[] {
    return [...this.store.values()];
  }

  symbols(): string[] {
    return [...this.store.keys()];
  }
}
