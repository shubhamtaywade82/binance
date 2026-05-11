import { describe, expect, it } from 'vitest';
import {
  normalizeTradingAsset,
  TRADING_ASSET_PRESETS,
} from '../src/config/asset-presets';

describe('asset presets', () => {
  it('normalizes asset codes', () => {
    expect(normalizeTradingAsset('ETH')).toBe('eth');
    expect(normalizeTradingAsset(undefined)).toBe('sol');
    expect(normalizeTradingAsset('bogus')).toBe('sol');
  });

  it('maps Binance + CoinDCX pairs', () => {
    expect(TRADING_ASSET_PRESETS.sol.binanceSymbol).toBe('SOLUSDT');
    expect(TRADING_ASSET_PRESETS.eth.coindcxPair).toBe('B-ETH_USDT');
    expect(TRADING_ASSET_PRESETS.btc.binanceSymbol).toBe('BTCUSDT');
  });
});
