import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CSV_HEADER =
  'prediction_id,timestamp,symbol,direction,ref_price,confidence,actual_price,edge_pct\n';

const dayStamp = (ts: number): string => {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/**
 * Records signal predictions and their outcomes to daily-rotated CSV files in `data/shadow/`.
 * Only active when `SHADOW_MODE=true`.
 */
export class ShadowPredictionLogger {
  private readonly dir: string;
  private currentDay = '';
  private currentPath = '';

  constructor(dir = 'data/shadow') {
    this.dir = dir;
  }

  logSignal(
    symbol: string,
    direction: 'LONG' | 'SHORT',
    refPrice: number,
    confidence: number,
  ): number {
    const predictionId = Date.now();
    this.ensureFile(predictionId);
    const line = `${predictionId},${new Date(predictionId).toISOString()},${symbol},${direction},${refPrice},${confidence},,\n`;
    appendFileSync(this.currentPath, line, 'utf8');
    return predictionId;
  }

  fillOutcome(predictionId: number, actualPriceAfterNSec: number): void {
    this.ensureFile(predictionId);
    const line = `${predictionId},${new Date(predictionId).toISOString()},,,,,${actualPriceAfterNSec},\n`;
    appendFileSync(this.currentPath, line, 'utf8');
  }

  /** Visible for testing. */
  filePath(): string {
    return this.currentPath;
  }

  private ensureFile(ts: number): void {
    const day = dayStamp(ts);
    if (day === this.currentDay && this.currentPath) return;
    this.currentDay = day;
    this.currentPath = join(this.dir, `shadow-${day}.csv`);
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.currentPath)) {
      appendFileSync(this.currentPath, CSV_HEADER, 'utf8');
    }
  }
}
