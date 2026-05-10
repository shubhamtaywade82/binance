import { describe, expect, it } from 'vitest';
import { LiquidationEngine, liquidationPrice } from '../src/execution/paper/liquidation';

describe('liquidationPrice', () => {
  it('computes LONG liquidation as entry * (1 - 1/lev + maint)', () => {
    const v = liquidationPrice({ entry: 100, side: 'LONG', leverage: 10, maintMargin: 0.005 });
    expect(v).toBeCloseTo(100 * (1 - 0.1 + 0.005), 8);
  });

  it('computes SHORT liquidation as entry * (1 + 1/lev - maint)', () => {
    const v = liquidationPrice({ entry: 100, side: 'SHORT', leverage: 10, maintMargin: 0.005 });
    expect(v).toBeCloseTo(100 * (1 + 0.1 - 0.005), 8);
  });
});

describe('LiquidationEngine', () => {
  it('triggers LONG when mark <= liq', () => {
    const e = new LiquidationEngine(0.005);
    e.track('o1', 'LONG', 100, 10);
    expect(e.triggered(95)).toHaveLength(0);
    expect(e.triggered(90.5)).toHaveLength(1);
  });

  it('triggers SHORT when mark >= liq', () => {
    const e = new LiquidationEngine(0.005);
    e.track('o2', 'SHORT', 100, 10);
    expect(e.triggered(105)).toHaveLength(0);
    expect(e.triggered(110)).toHaveLength(1);
  });

  it('untrack removes from triggers', () => {
    const e = new LiquidationEngine(0.005);
    e.track('o3', 'LONG', 100, 5);
    e.untrack('o3');
    expect(e.triggered(50)).toHaveLength(0);
  });
});
