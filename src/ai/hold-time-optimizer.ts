import type { ExtendedModelOutput } from './model-types';

export interface HoldTimeConfig {
  defaultHoldMs: number;
  minHoldMs: number;
  maxHoldMs: number;
}

const DEFAULT_CONFIG: HoldTimeConfig = {
  defaultHoldMs: 30_000,
  minHoldMs: 5_000,
  maxHoldMs: 300_000,
};

export const optimalHoldTimeMs = (
  modelOutput: ExtendedModelOutput,
  config?: Partial<HoldTimeConfig>,
): number => {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  let holdMs = cfg.defaultHoldMs;

  if (modelOutput.regime === 'chop') return cfg.minHoldMs;

  if (modelOutput.regime === 'trend') {
    holdMs *= 2;
  }

  if (modelOutput.expected_return != null && Number.isFinite(modelOutput.expected_return)) {
    const absReturn = Math.abs(modelOutput.expected_return);
    holdMs *= 1 + absReturn * 100;
  }

  return Math.max(cfg.minHoldMs, Math.min(cfg.maxHoldMs, holdMs));
};
