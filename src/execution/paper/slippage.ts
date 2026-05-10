export interface SlippageInputs {
  side: 'LONG' | 'SHORT';
  quantity: number;
  spread: number;
  volatilityPct: number;
  baseSlippageBps: number;
}

export class SlippageEngine {
  static priceImpactUsdt(i: SlippageInputs): number {
    const base = i.spread * 0.5;
    const vol = i.volatilityPct * 0.15;
    const size = i.quantity * 0.00001;
    const bps = i.baseSlippageBps / 10_000;
    return base + vol + size + bps;
  }
}
