import { describe, expect, it, vi } from 'vitest';
import { AssetPrecisionMapper } from '../src/mapping/asset-precision-mapper';
import * as fs from 'fs';

vi.mock('fs');

describe('AssetPrecisionMapper', () => {
  const mockConfig = JSON.stringify({
    offset: 2,
    overrides: {
      'PEPEUSDT': '0.00000000'
    }
  });

  it('loads config and applies overrides', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(mockConfig);

    const mapper = new AssetPrecisionMapper();
    
    expect(mapper.getDecimalPlaces('PEPEUSDT', 0.00001234, 4)).toBe(8);
  });

  it('applies offset rule based on tick decimals', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(mockConfig);

    const mapper = new AssetPrecisionMapper();
    
    // 1 tick decimal (BTC: 0.1) -> 3 decimals (1 + 2)
    expect(mapper.getDecimalPlaces('BTCUSDT', 65000, 1)).toBe(3);
    
    // 2 tick decimals (SOL: 0.01) -> 4 decimals (2 + 2)
    expect(mapper.getDecimalPlaces('SOLUSDT', 91.23, 2)).toBe(4);
    
    // 4 tick decimals (XRP: 0.0001) -> 6 decimals (4 + 2)
    expect(mapper.getDecimalPlaces('XRPUSDT', 0.5, 4)).toBe(6);
  });

  it('respects configured offset', () => {
    const customOffsetConfig = JSON.stringify({
      offset: 3,
      overrides: {}
    });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(customOffsetConfig);

    const mapper = new AssetPrecisionMapper();
    
    // 2 tick decimals + 3 offset = 5
    expect(mapper.getDecimalPlaces('SOLUSDT', 91.23, 2)).toBe(5);
  });
});
