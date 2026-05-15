export interface SlippageInputs {
  side: 'LONG' | 'SHORT';
  quantity: number;
  spread: number;
  volatilityPct: number;
  baseSlippageBps: number;
  topBookQty?: number;
  midPrice?: number;
  maxSlippageBps?: number;
}

export class SlippageEngine {
  static priceImpactUsdt(i: SlippageInputs): number {
    const base = i.spread * 0.5;
    const vol = i.volatilityPct * 0.15;

    let sizeImpact: number;
    if (i.topBookQty && i.topBookQty > 0 && i.midPrice && i.midPrice > 0) {
      sizeImpact = (i.quantity / i.topBookQty) * i.midPrice * 0.0005;
    } else {
      sizeImpact = i.quantity * 0.00001;
    }

    const bps = i.baseSlippageBps / 10_000;
    let total = base + vol + sizeImpact + bps;

    if (i.maxSlippageBps && i.maxSlippageBps > 0 && i.midPrice && i.midPrice > 0) {
      const cap = (i.maxSlippageBps / 10_000) * i.midPrice;
      total = Math.min(total, cap);
    }

    return total;
  }
}
