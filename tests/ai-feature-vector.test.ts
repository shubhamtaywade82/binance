import { describe, it, expect } from 'vitest';
import {
  buildFeatureVector,
  FEATURE_KEYS,
  featureVectorToArray,
  featureVectorToCsvRow,
  featureVectorCsvHeader,
  type FeatureSourceData,
} from '../src/ai/feature-schema';
import { FeatureNormalizer } from '../src/ai/feature-normalizer';
import type { MicrostructureSnapshot } from '../src/binance/microstructure';
import type { FundingSnapshot } from '../src/signals/funding-tracker';
import type { OiSnapshot } from '../src/signals/oi-poller';
import type { LiquidationSnapshot } from '../src/signals/liquidation-tracker';

const makeMicro = (overrides?: Partial<MicrostructureSnapshot>): MicrostructureSnapshot => ({
  tfi1s: { tfi: 10, buyVol: 15, sellVol: 5, tradeCount: 20 },
  tfi5s: { tfi: 30, buyVol: 40, sellVol: 10, tradeCount: 80 },
  tfi30s: { tfi: 100, buyVol: 150, sellVol: 50, tradeCount: 300 },
  weightedObi5: { weightedObi: 0.3, bidWeightedVol: 65, askWeightedVol: 35 },
  weightedObi10: { weightedObi: 0.2, bidWeightedVol: 120, askWeightedVol: 80 },
  microprice: 100.5,
  spread: 0.1,
  spreadBps: 10,
  mid: 100,
  depthPressure10: { depthPressure: 500, bidPressure: 1200, askPressure: 700 },
  rv1s: { rv: 0.001, sampleCount: 10 },
  rv5s: { rv: 0.002, sampleCount: 50 },
  rv1m: { rv: 0.003, sampleCount: 200 },
  ...overrides,
});

const makeFunding = (): FundingSnapshot => ({
  currentRate: 0.0001,
  zscore: 0.5,
  extremeFlag: false,
  crowdedSide: 'NEUTRAL',
});

const makeOi = (): OiSnapshot => ({
  oi: 50000,
  oiDelta1m: 100,
  oiZscore: 1.2,
  regime: 'price_up_oi_up',
});

const makeLiquidation = (): LiquidationSnapshot => ({
  volume30s: 500000,
  count30s: 15,
  sideBias30s: 0.3,
});

const makeSource = (overrides?: Partial<FeatureSourceData>): FeatureSourceData => ({
  micro: makeMicro(),
  funding: makeFunding(),
  oi: makeOi(),
  liquidation: makeLiquidation(),
  ofiCumulative: 42,
  symbol: 'SOLUSDT',
  candle1m: { openTime: 1000, open: 99, high: 101, low: 98, close: 100, volume: 5000 },
  candle5m: { openTime: 1000, open: 98, high: 102, low: 97, close: 101, volume: 25000 },
  ...overrides,
});

describe('feature-schema', () => {
  describe('buildFeatureVector', () => {
    it('produces a vector with all required keys', () => {
      const fv = buildFeatureVector(makeSource());
      for (const key of FEATURE_KEYS) {
        expect(fv).toHaveProperty(key);
        expect(typeof fv[key]).toBe('number');
      }
      expect(fv.symbol).toBe('SOLUSDT');
      expect(fv.timestamp).toBeGreaterThan(0);
    });

    it('maps microstructure fields correctly', () => {
      const fv = buildFeatureVector(makeSource());
      expect(fv.obi_5).toBe(0.3);
      expect(fv.obi_10).toBe(0.2);
      expect(fv.trade_imbalance_1s).toBe(10);
      expect(fv.trade_imbalance_5s).toBe(30);
      expect(fv.microprice).toBe(100.5);
      expect(fv.spread).toBe(0.1);
      expect(fv.spread_bps).toBe(10);
    });

    it('maps signal tracker fields correctly', () => {
      const fv = buildFeatureVector(makeSource());
      expect(fv.funding_rate).toBe(0.0001);
      expect(fv.funding_zscore).toBe(0.5);
      expect(fv.funding_extreme_flag).toBe(0);
      expect(fv.oi).toBe(50000);
      expect(fv.oi_delta_1m).toBe(100);
      expect(fv.oi_zscore).toBe(1.2);
      expect(fv.price_oi_regime).toBe(1);
      expect(fv.liquidation_volume_30s).toBe(500000);
      expect(fv.liquidation_side_bias_30s).toBe(0.3);
    });

    it('computes candle-derived features', () => {
      const fv = buildFeatureVector(makeSource());
      expect(fv.ret_1m).toBeCloseTo(Math.log(100 / 99), 4);
      expect(fv.ret_5m).toBeCloseTo(Math.log(101 / 98), 4);
      expect(fv.candle_body_1m).toBeCloseTo(Math.abs(100 - 99) / (101 - 98), 4);
    });

    it('handles missing candles gracefully', () => {
      const fv = buildFeatureVector(makeSource({ candle1m: undefined, candle5m: undefined }));
      expect(fv.ret_1m).toBe(0);
      expect(fv.ret_5m).toBe(0);
      expect(fv.candle_body_1m).toBe(0);
      expect(fv.wick_ratio_upper_1m).toBe(0);
    });

    it('encodes funding extreme flag as 1', () => {
      const src = makeSource();
      src.funding = { ...makeFunding(), extremeFlag: true };
      const fv = buildFeatureVector(src);
      expect(fv.funding_extreme_flag).toBe(1);
    });

    it('encodes regime correctly', () => {
      const regimes = [
        { regime: 'price_up_oi_up' as const, expected: 1 },
        { regime: 'price_down_oi_down' as const, expected: 4 },
        { regime: 'neutral' as const, expected: 0 },
      ];
      for (const { regime, expected } of regimes) {
        const src = makeSource();
        src.oi = { ...makeOi(), regime };
        const fv = buildFeatureVector(src);
        expect(fv.price_oi_regime).toBe(expected);
      }
    });
  });

  describe('featureVectorToArray', () => {
    it('returns an array with length matching FEATURE_KEYS', () => {
      const fv = buildFeatureVector(makeSource());
      const arr = featureVectorToArray(fv);
      expect(arr.length).toBe(FEATURE_KEYS.length);
      expect(arr.every((v) => typeof v === 'number')).toBe(true);
    });
  });

  describe('featureVectorToCsvRow', () => {
    it('produces comma-separated values with timestamp and symbol prefix', () => {
      const fv = buildFeatureVector(makeSource());
      const row = featureVectorToCsvRow(fv);
      const parts = row.split(',');
      expect(parts.length).toBe(FEATURE_KEYS.length + 2);
      expect(parts[1]).toBe('SOLUSDT');
    });
  });

  describe('featureVectorCsvHeader', () => {
    it('starts with timestamp,symbol then feature keys', () => {
      const header = featureVectorCsvHeader();
      const cols = header.split(',');
      expect(cols[0]).toBe('timestamp');
      expect(cols[1]).toBe('symbol');
      expect(cols.length).toBe(FEATURE_KEYS.length + 2);
    });
  });
});

describe('FeatureNormalizer', () => {
  it('returns zeros for the first sample', () => {
    const norm = new FeatureNormalizer(100);
    const fv = buildFeatureVector(makeSource());
    const result = norm.normalize(fv);
    for (const key of FEATURE_KEYS) {
      expect(result[key]).toBe(0);
    }
  });

  it('produces non-zero z-scores after sufficient samples', () => {
    const norm = new FeatureNormalizer(100);
    for (let i = 0; i < 50; i++) {
      const src = makeSource();
      src.micro = makeMicro({ spread: 0.1 + i * 0.001 });
      norm.normalize(buildFeatureVector(src));
    }
    const outlier = makeSource();
    outlier.micro = makeMicro({ spread: 0.5 });
    const result = norm.normalize(buildFeatureVector(outlier));
    expect(Math.abs(result.spread)).toBeGreaterThan(0);
  });

  it('winsorizes at +/-5 sigma', () => {
    const norm = new FeatureNormalizer(100);
    for (let i = 0; i < 100; i++) {
      const src = makeSource();
      src.micro = makeMicro({ spread: 0.1 });
      norm.normalize(buildFeatureVector(src));
    }
    const extreme = makeSource();
    extreme.micro = makeMicro({ spread: 100 });
    const result = norm.normalize(buildFeatureVector(extreme));
    expect(result.spread).toBeLessThanOrEqual(5);
    expect(result.spread).toBeGreaterThanOrEqual(-5);
  });

  it('reset clears accumulated stats', () => {
    const norm = new FeatureNormalizer(100);
    for (let i = 0; i < 10; i++) {
      norm.normalize(buildFeatureVector(makeSource()));
    }
    norm.reset();
    const result = norm.normalize(buildFeatureVector(makeSource()));
    for (const key of FEATURE_KEYS) {
      expect(result[key]).toBe(0);
    }
  });
});
