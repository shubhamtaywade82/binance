export interface CorrelationPair {
  symbolA: string;
  symbolB: string;
  correlation: number; // -1 to 1
}

export interface CorrelationGuardConfig {
  threshold: number; // pairs above this are "highly correlated"
}

const DEFAULT_CONFIG: CorrelationGuardConfig = { threshold: 0.7 };

export class CorrelationGuard {
  private matrix = new Map<string, number>();
  private config: CorrelationGuardConfig;

  constructor(pairs: CorrelationPair[], config?: Partial<CorrelationGuardConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storePairs(pairs);
  }

  updateCorrelations(pairs: CorrelationPair[]): void {
    this.matrix.clear();
    this.storePairs(pairs);
  }

  getCorrelation(symbolA: string, symbolB: string): number | null {
    return this.matrix.get(this.key(symbolA, symbolB)) ?? null;
  }

  wouldViolate(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    openPositions: Map<string, 'LONG' | 'SHORT'>,
  ): { blocked: boolean; reason?: string } {
    for (const [openSym, openDir] of openPositions) {
      const corr = this.getCorrelation(symbol, openSym);
      if (corr === null) continue;

      const sameDirection = direction === openDir;
      const { threshold } = this.config;

      if (sameDirection && corr > threshold) {
        return {
          blocked: true,
          reason: `${symbol} ${direction} blocked: highly correlated (${corr.toFixed(2)}) with open ${openSym} ${openDir}`,
        };
      }

      if (!sameDirection && corr < -threshold) {
        return {
          blocked: true,
          reason: `${symbol} ${direction} blocked: highly negatively correlated (${corr.toFixed(2)}) with open ${openSym} ${openDir} — redundant exposure`,
        };
      }
    }

    return { blocked: false };
  }

  private key(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  private storePairs(pairs: CorrelationPair[]): void {
    for (const { symbolA, symbolB, correlation } of pairs) {
      this.matrix.set(this.key(symbolA, symbolB), correlation);
    }
  }
}
