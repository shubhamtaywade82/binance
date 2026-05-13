export interface ModelOutput {
  p_up: number;
  p_down: number;
  p_flat: number;
}

export interface ExtendedModelOutput extends ModelOutput {
  regime?: 'trend' | 'mean_revert' | 'chop' | 'high_vol' | 'low_liq';
  expected_return?: number;
  expected_slippage?: number;
  model_version?: string;
}

export interface PredictionRecord {
  timestamp: number;
  symbol: string;
  model_output: ModelOutput;
  signal: 'LONG' | 'SHORT' | 'HOLD';
  mid_price: number;
  actual_outcome?: number;
  actual_direction?: 1 | -1 | 0;
  outcome_filled_at?: number;
}
