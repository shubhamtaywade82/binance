import type { AppConfig } from '../config';

export interface ResolvedPairMap {
  binanceSymbol: string;
  coindcxPair: string;
}

export const resolvePairMap = (cfg: AppConfig): ResolvedPairMap => {
  return {
    binanceSymbol: cfg.BINANCE_SYMBOL.trim().toUpperCase(),
    coindcxPair: cfg.COINDCX_PAIR.trim(),
  };
}
