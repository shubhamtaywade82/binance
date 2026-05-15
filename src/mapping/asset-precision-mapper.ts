import * as fs from 'fs';
import * as path from 'path';

export interface PrecisionConfig {
  offset: number;
  overrides: Record<string, string>;
}

export class AssetPrecisionMapper {
  private config: PrecisionConfig;

  constructor(configPath?: string) {
    const resolvedPath = configPath ?? path.resolve(process.cwd(), 'config/precision.json');
    this.config = this.loadConfig(resolvedPath);
  }

  private loadConfig(p: string): PrecisionConfig {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error(`Failed to load precision config from ${p}:`, e);
    }
    return { offset: 2, overrides: {} };
  }

  /**
   * Returns the number of decimal places for a given symbol and its current/typical price.
   * Logic: Exchange Tick Decimals + Configured Offset (default 2).
   */
  getDecimalPlaces(symbol: string, _price: number, tickDecimals: number): number {
    // Reload config to pick up changes in precision.json without restart
    const resolvedPath = path.resolve(process.cwd(), 'config/precision.json');
    this.config = this.loadConfig(resolvedPath);

    const sym = symbol.toUpperCase();
    
    // 1. Check overrides first
    if (this.config.overrides[sym]) {
      return this.parseFormat(this.config.overrides[sym]);
    }

    // 2. Apply "Tick Decimals + Offset" rule
    const offset = Number.isFinite(this.config.offset) ? this.config.offset : 2;
    return tickDecimals + offset;
  }

  private parseFormat(format: string): number {
    const dotIndex = format.indexOf('.');
    if (dotIndex === -1) return 0;
    return format.length - dotIndex - 1;
  }
}

/** Global instance for easy use in dashboard bridge. */
export const assetPrecisionMapper = new AssetPrecisionMapper();
