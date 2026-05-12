export interface LiquidationInputs {
  entry: number;
  side: 'LONG' | 'SHORT';
  leverage: number;
  maintMargin: number;
}

export const liquidationPrice = (i: LiquidationInputs): number => {
  const inv = 1 / i.leverage;
  return i.side === 'LONG'
    ? i.entry * (1 - inv + i.maintMargin)
    : i.entry * (1 + inv - i.maintMargin);
}

export interface TrackedLiq {
  orderId: string;
  side: 'LONG' | 'SHORT';
  liqPrice: number;
}

export class LiquidationEngine {
  private positions = new Map<string, TrackedLiq>();

  constructor(private readonly maintMargin: number) {}

  track(orderId: string, side: 'LONG' | 'SHORT', entry: number, leverage: number): number {
    const liq = liquidationPrice({ entry, side, leverage, maintMargin: this.maintMargin });
    this.positions.set(orderId, { orderId, side, liqPrice: liq });
    return liq;
  }

  untrack(orderId: string): void {
    this.positions.delete(orderId);
  }

  triggered(mark: number): TrackedLiq[] {
    const out: TrackedLiq[] = [];
    for (const p of this.positions.values()) {
      if (p.side === 'LONG' && mark <= p.liqPrice) out.push(p);
      else if (p.side === 'SHORT' && mark >= p.liqPrice) out.push(p);
    }
    return out;
  }

  get maintenanceMargin(): number {
    return this.maintMargin;
  }
}
