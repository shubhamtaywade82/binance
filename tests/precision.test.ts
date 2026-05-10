import { describe, expect, it } from 'vitest';
import { extractPrecisionFromInstrument, floorToStep } from '../src/mapping/precision';

describe('extractPrecisionFromInstrument', () => {
  it('uses defaults for empty payload', () => {
    const p = extractPrecisionFromInstrument(null);
    expect(p.tickSize).toBe(0.01);
    expect(p.stepSize).toBe(0.001);
  });

  it('reads flat fields', () => {
    const p = extractPrecisionFromInstrument({
      tick_size: 0.5,
      quantity_step: 0.01,
      min_quantity: 0.02,
    });
    expect(p).toEqual({ tickSize: 0.5, stepSize: 0.01, minQty: 0.02 });
  });

  it('reads nested data object', () => {
    const p = extractPrecisionFromInstrument({
      data: { tickSize: 0.1, stepSize: 0.25, minQuantity: 0.25 },
    });
    expect(p).toEqual({ tickSize: 0.1, stepSize: 0.25, minQty: 0.25 });
  });
});

describe('floorToStep', () => {
  it('floors to step', () => {
    expect(floorToStep(1.234, 0.01)).toBe(1.23);
    expect(floorToStep(10, 3)).toBe(9);
  });
});
