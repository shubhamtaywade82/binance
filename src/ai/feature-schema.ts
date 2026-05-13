import type { MicrostructureSnapshot } from '../binance/microstructure';
import type { FundingSnapshot } from '../signals/funding-tracker';
import type { OiSnapshot } from '../signals/oi-poller';
import type { LiquidationSnapshot } from '../signals/liquidation-tracker';
import type { Candle } from '../types';

export interface FeatureVector {
  timestamp: number;
  symbol: string;

  mid_price: number;
  bid_price: number;
  ask_price: number;
  spread: number;

  obi_5: number;
  obi_10: number;
  weighted_depth_imbalance: number;
  microprice: number;
  book_pressure: number;
  spread_bps: number;

  trade_imbalance_1s: number;
  trade_imbalance_5s: number;
  trade_imbalance_30s: number;
  trade_intensity_1s: number;

  ofi_cumulative: number;

  rv_1s: number;
  rv_5s: number;
  rv_1m: number;

  ret_1m: number;
  ret_5m: number;
  vol_1m: number;
  candle_body_1m: number;
  wick_ratio_upper_1m: number;

  oi: number;
  oi_delta_1m: number;
  oi_zscore: number;
  price_oi_regime: number;

  funding_rate: number;
  funding_zscore: number;
  funding_extreme_flag: number;
  liquidation_volume_30s: number;
  liquidation_side_bias_30s: number;

  vol_regime_flag: number;
  trend_strength: number;
}

export const FEATURE_KEYS: ReadonlyArray<keyof FeatureVector> = [
  'mid_price',
  'bid_price',
  'ask_price',
  'spread',
  'obi_5',
  'obi_10',
  'weighted_depth_imbalance',
  'microprice',
  'book_pressure',
  'spread_bps',
  'trade_imbalance_1s',
  'trade_imbalance_5s',
  'trade_imbalance_30s',
  'trade_intensity_1s',
  'ofi_cumulative',
  'rv_1s',
  'rv_5s',
  'rv_1m',
  'ret_1m',
  'ret_5m',
  'vol_1m',
  'candle_body_1m',
  'wick_ratio_upper_1m',
  'oi',
  'oi_delta_1m',
  'oi_zscore',
  'price_oi_regime',
  'funding_rate',
  'funding_zscore',
  'funding_extreme_flag',
  'liquidation_volume_30s',
  'liquidation_side_bias_30s',
  'vol_regime_flag',
  'trend_strength',
] as const;

const REGIME_ENCODING: Record<string, number> = {
  price_up_oi_up: 1,
  price_up_oi_down: 2,
  price_down_oi_up: 3,
  price_down_oi_down: 4,
  neutral: 0,
};

export interface FeatureSourceData {
  micro: MicrostructureSnapshot;
  funding: FundingSnapshot;
  oi: OiSnapshot;
  liquidation: LiquidationSnapshot;
  ofiCumulative: number;
  candle1m?: Candle;
  candle5m?: Candle;
  symbol: string;
}

export const buildFeatureVector = (src: FeatureSourceData): FeatureVector => {
  const { micro, funding, oi, liquidation, candle1m, candle5m } = src;

  const mid = micro.mid ?? 0;
  const bidPrice = mid - (micro.spread ?? 0) / 2;
  const askPrice = mid + (micro.spread ?? 0) / 2;

  const candleBody1m = candleBodyPct(candle1m);
  const wickUpper1m = upperWickRatio(candle1m);

  const ret1m = candle1m ? logReturn(candle1m) : 0;
  const ret5m = candle5m ? logReturn(candle5m) : 0;
  const vol1m = micro.rv1m.rv;

  const volRegimeFlag = vol1m > 2 * micro.rv5s.rv && micro.rv5s.rv > 0 ? 1 : 0;
  const trendStrength = vol1m > 0 ? Math.abs(ret1m) / vol1m : 0;

  return {
    timestamp: Date.now(),
    symbol: src.symbol,

    mid_price: mid,
    bid_price: bidPrice,
    ask_price: askPrice,
    spread: micro.spread ?? 0,

    obi_5: micro.weightedObi5.weightedObi,
    obi_10: micro.weightedObi10.weightedObi,
    weighted_depth_imbalance: micro.depthPressure10.depthPressure,
    microprice: micro.microprice ?? mid,
    book_pressure: micro.depthPressure10.bidPressure - micro.depthPressure10.askPressure,
    spread_bps: micro.spreadBps ?? 0,

    trade_imbalance_1s: micro.tfi1s.tfi,
    trade_imbalance_5s: micro.tfi5s.tfi,
    trade_imbalance_30s: micro.tfi30s.tfi,
    trade_intensity_1s: micro.tfi1s.tradeCount,

    ofi_cumulative: src.ofiCumulative,

    rv_1s: micro.rv1s.rv,
    rv_5s: micro.rv5s.rv,
    rv_1m: vol1m,

    ret_1m: ret1m,
    ret_5m: ret5m,
    vol_1m: vol1m,
    candle_body_1m: candleBody1m,
    wick_ratio_upper_1m: wickUpper1m,

    oi: oi.oi,
    oi_delta_1m: oi.oiDelta1m,
    oi_zscore: oi.oiZscore,
    price_oi_regime: REGIME_ENCODING[oi.regime] ?? 0,

    funding_rate: funding.currentRate,
    funding_zscore: funding.zscore,
    funding_extreme_flag: funding.extremeFlag ? 1 : 0,
    liquidation_volume_30s: liquidation.volume30s,
    liquidation_side_bias_30s: liquidation.sideBias30s,

    vol_regime_flag: volRegimeFlag,
    trend_strength: trendStrength,
  };
};

const logReturn = (c: Candle): number =>
  c.open > 0 ? Math.log(c.close / c.open) : 0;

const candleBodyPct = (c?: Candle): number => {
  if (!c) return 0;
  const range = c.high - c.low;
  return range > 0 ? Math.abs(c.close - c.open) / range : 0;
};

const upperWickRatio = (c?: Candle): number => {
  if (!c) return 0;
  const range = c.high - c.low;
  return range > 0 ? (c.high - Math.max(c.open, c.close)) / range : 0;
};

export const featureVectorToArray = (fv: FeatureVector): number[] =>
  FEATURE_KEYS.map((k) => fv[k] as number);

export const featureVectorToCsvRow = (fv: FeatureVector): string => {
  const parts = [fv.timestamp.toString(), fv.symbol];
  for (const k of FEATURE_KEYS) parts.push(String(fv[k]));
  return parts.join(',');
};

export const featureVectorCsvHeader = (): string =>
  ['timestamp', 'symbol', ...FEATURE_KEYS].join(',');
