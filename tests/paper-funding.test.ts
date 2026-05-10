import { describe, expect, it } from 'vitest';
import { FundingEngine } from '../src/execution/paper/funding';

function makeEngine(now: { t: number }): FundingEngine {
  return new FundingEngine({
    binanceRestBase: 'https://example.test',
    pollSec: 60,
    now: () => now.t,
  });
}

describe('FundingEngine', () => {
  it('charges LONG positive rate as cost (positive accrual)', () => {
    const now = { t: 1000 };
    const e = makeEngine(now);
    e.trackPosition({ positionId: 'p1', symbol: 'SOLUSDT', side: 'LONG', notional: () => 1000 });
    e.setRateForSymbol('SOLUSDT', 0.0001, 500);
    e.applyFundingIfDue();
    expect(e.accruedFor('p1')).toBeCloseTo(0.1, 8);
  });

  it('credits SHORT when rate is positive (negative accrual)', () => {
    const now = { t: 1000 };
    const e = makeEngine(now);
    e.trackPosition({ positionId: 'p2', symbol: 'SOLUSDT', side: 'SHORT', notional: () => 1000 });
    e.setRateForSymbol('SOLUSDT', 0.0001, 500);
    e.applyFundingIfDue();
    expect(e.accruedFor('p2')).toBeCloseTo(-0.1, 8);
  });

  it('does not charge before nextFundingTime', () => {
    const now = { t: 100 };
    const e = makeEngine(now);
    e.trackPosition({ positionId: 'p3', symbol: 'SOLUSDT', side: 'LONG', notional: () => 1000 });
    e.setRateForSymbol('SOLUSDT', 0.0001, 500);
    e.applyFundingIfDue();
    expect(e.accruedFor('p3')).toBe(0);
  });

  it('is idempotent for the same nextFundingTime', () => {
    const now = { t: 1000 };
    const e = makeEngine(now);
    e.trackPosition({ positionId: 'p4', symbol: 'SOLUSDT', side: 'LONG', notional: () => 1000 });
    e.setRateForSymbol('SOLUSDT', 0.0001, 500);
    e.applyFundingIfDue();
    e.applyFundingIfDue();
    e.applyFundingIfDue();
    expect(e.accruedFor('p4')).toBeCloseTo(0.1, 8);
  });

  it('charges again on a new funding window', () => {
    const now = { t: 1000 };
    const e = makeEngine(now);
    e.trackPosition({ positionId: 'p5', symbol: 'SOLUSDT', side: 'LONG', notional: () => 1000 });
    e.setRateForSymbol('SOLUSDT', 0.0001, 500);
    e.applyFundingIfDue();
    now.t = 2000;
    e.setRateForSymbol('SOLUSDT', 0.0002, 1500);
    e.applyFundingIfDue();
    expect(e.accruedFor('p5')).toBeCloseTo(0.1 + 0.2, 8);
  });
});
