import { describe, it, expect } from 'vitest';
import { mlDecide, mlDecideStandalone, type MLGateConfig } from '../src/ai/ml-gate';
import type { ModelOutput } from '../src/ai/model-types';

const defaultConfig: MLGateConfig = {
  minProbability: 0.65,
  minEdgeBps: 8,
  takerRoundTripBps: 8,
  chopThreshold: 0.50,
};

describe('mlDecide', () => {
  it('returns null when p_flat exceeds chop threshold', () => {
    const output: ModelOutput = { p_up: 0.3, p_down: 0.1, p_flat: 0.6 };
    expect(mlDecide(output, 'LONG', defaultConfig)).toBeNull();
  });

  it('returns null when dominant probability is below threshold', () => {
    const output: ModelOutput = { p_up: 0.5, p_down: 0.1, p_flat: 0.4 };
    expect(mlDecide(output, 'LONG', defaultConfig)).toBeNull();
  });

  it('returns LONG when p_up passes and SMC agrees', () => {
    const output: ModelOutput = { p_up: 0.75, p_down: 0.05, p_flat: 0.2 };
    expect(mlDecide(output, 'LONG', defaultConfig)).toBe('LONG');
  });

  it('returns SHORT when p_down passes and SMC agrees', () => {
    const output: ModelOutput = { p_up: 0.05, p_down: 0.75, p_flat: 0.2 };
    expect(mlDecide(output, 'SHORT', defaultConfig)).toBe('SHORT');
  });

  it('returns null when ML and SMC disagree on direction', () => {
    const output: ModelOutput = { p_up: 0.75, p_down: 0.05, p_flat: 0.2 };
    expect(mlDecide(output, 'SHORT', defaultConfig)).toBeNull();
  });

  it('returns null when edge check fails (p barely above 0.5)', () => {
    const cfg: MLGateConfig = { ...defaultConfig, minProbability: 0.50 };
    const output: ModelOutput = { p_up: 0.50, p_down: 0.10, p_flat: 0.40 };
    expect(mlDecide(output, 'LONG', cfg)).toBeNull();
  });

  it('respects custom minProbability', () => {
    const strict: MLGateConfig = { ...defaultConfig, minProbability: 0.90 };
    const output: ModelOutput = { p_up: 0.80, p_down: 0.05, p_flat: 0.15 };
    expect(mlDecide(output, 'LONG', strict)).toBeNull();
  });

  it('uses defaults when no config provided', () => {
    const output: ModelOutput = { p_up: 0.75, p_down: 0.05, p_flat: 0.2 };
    expect(mlDecide(output, 'LONG')).toBe('LONG');
  });
});

describe('mlDecideStandalone', () => {
  it('returns LONG purely from model output without SMC', () => {
    const output: ModelOutput = { p_up: 0.75, p_down: 0.05, p_flat: 0.2 };
    expect(mlDecideStandalone(output, defaultConfig)).toBe('LONG');
  });

  it('returns SHORT purely from model output without SMC', () => {
    const output: ModelOutput = { p_up: 0.05, p_down: 0.75, p_flat: 0.2 };
    expect(mlDecideStandalone(output, defaultConfig)).toBe('SHORT');
  });

  it('returns null for chop regime', () => {
    const output: ModelOutput = { p_up: 0.3, p_down: 0.1, p_flat: 0.6 };
    expect(mlDecideStandalone(output, defaultConfig)).toBeNull();
  });
});
