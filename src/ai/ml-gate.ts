import type { ModelOutput } from './model-types';

export interface MLGateConfig {
  minProbability: number;
  minEdgeBps: number;
  takerRoundTripBps: number;
  chopThreshold: number;
}

const DEFAULT_GATE_CONFIG: MLGateConfig = {
  minProbability: 0.65,
  minEdgeBps: 8,
  takerRoundTripBps: 8,
  chopThreshold: 0.50,
};

export type MLSignal = 'LONG' | 'SHORT' | null;

export const mlDecide = (
  output: ModelOutput,
  smcSignal: 'LONG' | 'SHORT' | null,
  config?: Partial<MLGateConfig>,
): MLSignal => {
  const cfg = { ...DEFAULT_GATE_CONFIG, ...config };

  if (output.p_flat > cfg.chopThreshold) return null;

  const dominantP = Math.max(output.p_up, output.p_down);
  if (!passesEdgeCheck(dominantP, cfg)) return null;

  if (output.p_up > cfg.minProbability && smcSignal === 'LONG') return 'LONG';
  if (output.p_down > cfg.minProbability && smcSignal === 'SHORT') return 'SHORT';

  return null;
};

export const mlDecideStandalone = (
  output: ModelOutput,
  config?: Partial<MLGateConfig>,
): MLSignal => {
  const cfg = { ...DEFAULT_GATE_CONFIG, ...config };

  if (output.p_flat > cfg.chopThreshold) return null;

  const dominantP = Math.max(output.p_up, output.p_down);
  if (!passesEdgeCheck(dominantP, cfg)) return null;

  if (output.p_up > cfg.minProbability) return 'LONG';
  if (output.p_down > cfg.minProbability) return 'SHORT';

  return null;
};

/**
 * EV = (2p - 1) * avgEdge must be positive (i.e. p > 0.5).
 * The probability threshold already enforces p > minProbability (0.65),
 * so this guard catches edge cases where dominantP is barely above 0.5.
 */
const passesEdgeCheck = (dominantP: number, cfg: MLGateConfig): boolean => {
  const ev = (2 * dominantP - 1) * cfg.minEdgeBps;
  return ev > 0;
};
