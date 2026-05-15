/**
 * Per-symbol tier configuration for multi-asset paper trading.
 *
 * Tiers:
 *   - `scalp`: short timeframe execution (e.g. 5m LTF / 1h HTF), tight TP/SL, higher leverage.
 *     Uses the SOL-MTF + SMC-confluence + microstructure stack.
 *   - `swing`: higher timeframe (15m LTF / 4h HTF), wider TP/SL, lower leverage.
 *     Uses the lighter swing strategy (HTF bias + displacement + FVG/OB retracement).
 *
 * Per-symbol overrides can be supplied at runtime via the `ASSET_TIER_OVERRIDES_JSON`
 * env var — a JSON object keyed by uppercase symbol whose values are partial
 * `AssetTierConfig`s. They are merged into the defaults by `applyTierOverrides()`.
 */
export type StrategyTier = 'scalp' | 'swing';

export interface AssetTierConfig {
  symbol: string;
  tier: StrategyTier;
  /** Execution / signal-generation timeframe (e.g. '5m'). */
  ltf: string;
  /** Bias / confluence timeframe (e.g. '1h'). */
  htf: string;
  leverage: number;
  /** Take-profit price move as a fraction (e.g. 0.007 = 0.7%). */
  tpPct: number;
  /** Stop-loss price move as a fraction. */
  slPct: number;
  /** Margin allocated per trade in USDT (size = marginUsdt * leverage / entryPrice). */
  marginUsdt: number;
  /** Minimum confidence threshold for strategy gating. */
  minConfidence: number;
}

const DEFAULT_TIERS: Record<string, AssetTierConfig> = {
  BTCUSDT:  { symbol: 'BTCUSDT',  tier: 'scalp', ltf: '5m',  htf: '1h', leverage: 5, tpPct: 0.007, slPct: 0.004, marginUsdt: 1500, minConfidence: 0.65 },
  ETHUSDT:  { symbol: 'ETHUSDT',  tier: 'scalp', ltf: '5m',  htf: '1h', leverage: 5, tpPct: 0.008, slPct: 0.005, marginUsdt: 1500, minConfidence: 0.65 },
  SOLUSDT:  { symbol: 'SOLUSDT',  tier: 'scalp', ltf: '5m',  htf: '1h', leverage: 5, tpPct: 0.010, slPct: 0.006, marginUsdt: 1200, minConfidence: 0.65 },
  XRPUSDT:  { symbol: 'XRPUSDT',  tier: 'scalp', ltf: '5m',  htf: '1h', leverage: 5, tpPct: 0.012, slPct: 0.007, marginUsdt: 1000, minConfidence: 0.65 },
  SUIUSDT:  { symbol: 'SUIUSDT',  tier: 'swing', ltf: '15m', htf: '4h', leverage: 3, tpPct: 0.025, slPct: 0.015, marginUsdt: 800,  minConfidence: 0.70 },
  AVAXUSDT: { symbol: 'AVAXUSDT', tier: 'swing', ltf: '15m', htf: '4h', leverage: 3, tpPct: 0.022, slPct: 0.013, marginUsdt: 800,  minConfidence: 0.70 },
  LINKUSDT: { symbol: 'LINKUSDT', tier: 'swing', ltf: '15m', htf: '4h', leverage: 3, tpPct: 0.020, slPct: 0.012, marginUsdt: 800,  minConfidence: 0.70 },
};

/** Module-level mutable registry. Mutated only via `applyTierOverrides()`. */
const REGISTRY: Record<string, AssetTierConfig> = { ...DEFAULT_TIERS };

/** Convenience read-only view kept compatible with the legacy task description. */
export const ASSET_TIERS: Readonly<Record<string, AssetTierConfig>> = REGISTRY;

export const tierFor = (symbol: string): AssetTierConfig | null => {
  if (!symbol) return null;
  return REGISTRY[symbol.toUpperCase()] ?? null;
};

export const tieredSymbols = (): string[] => Object.keys(REGISTRY);

const STRATEGY_TIERS: ReadonlySet<StrategyTier> = new Set(['scalp', 'swing']);

const isAssetTierPartial = (value: unknown): value is Partial<AssetTierConfig> => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.tier !== undefined && (typeof v.tier !== 'string' || !STRATEGY_TIERS.has(v.tier as StrategyTier))) return false;
  for (const k of ['leverage', 'tpPct', 'slPct', 'marginUsdt', 'minConfidence'] as const) {
    if (v[k] !== undefined && (typeof v[k] !== 'number' || !Number.isFinite(v[k] as number))) return false;
  }
  for (const k of ['ltf', 'htf', 'symbol'] as const) {
    if (v[k] !== undefined && typeof v[k] !== 'string') return false;
  }
  return true;
};

/**
 * Parse `ASSET_TIER_OVERRIDES_JSON` and merge into the in-process registry.
 * Unknown symbols are added (as net-new tier configs) only when the JSON entry
 * contains *all* required fields; partial entries for unknown symbols are dropped.
 *
 * Returns the merged registry view. Safe to call multiple times.
 */
export const applyTierOverrides = (rawJson: string | undefined | null): Readonly<Record<string, AssetTierConfig>> => {
  if (!rawJson || !rawJson.trim()) return REGISTRY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return REGISTRY;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return REGISTRY;

  for (const [rawSym, override] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isAssetTierPartial(override)) continue;
    const sym = rawSym.toUpperCase();
    const base = REGISTRY[sym];
    if (base) {
      REGISTRY[sym] = { ...base, ...override, symbol: sym };
    } else {
      // Net-new symbol — require the full shape.
      const o = override as Partial<AssetTierConfig>;
      if (
        o.tier && o.ltf && o.htf &&
        typeof o.leverage === 'number' &&
        typeof o.tpPct === 'number' &&
        typeof o.slPct === 'number' &&
        typeof o.marginUsdt === 'number' &&
        typeof o.minConfidence === 'number'
      ) {
        REGISTRY[sym] = {
          symbol: sym,
          tier: o.tier,
          ltf: o.ltf,
          htf: o.htf,
          leverage: o.leverage,
          tpPct: o.tpPct,
          slPct: o.slPct,
          marginUsdt: o.marginUsdt,
          minConfidence: o.minConfidence,
        };
      }
    }
  }
  return REGISTRY;
};

/** Test-only: restore registry to compile-time defaults. */
export const resetTierRegistryForTests = (): void => {
  for (const k of Object.keys(REGISTRY)) delete REGISTRY[k];
  Object.assign(REGISTRY, DEFAULT_TIERS);
};
