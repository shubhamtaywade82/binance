export interface VolSizerConfig {
  baselineVol: number;
  maxScaleDown: number;
  maxScaleUp: number;
}

const DEFAULT_CONFIG: VolSizerConfig = {
  baselineVol: 0.003,
  maxScaleDown: 0.25,
  maxScaleUp: 1.5,
};

export const volatilitySizedPosition = (
  baseQty: number,
  expectedVol: number,
  config?: Partial<VolSizerConfig>,
): number => {
  if (baseQty <= 0) return 0;
  if (!Number.isFinite(expectedVol) || expectedVol <= 0) return baseQty;

  const cfg = { ...DEFAULT_CONFIG, ...config };

  const ratio = cfg.baselineVol / expectedVol;
  const clamped = Math.max(cfg.maxScaleDown, Math.min(cfg.maxScaleUp, ratio));

  return baseQty * clamped;
};
