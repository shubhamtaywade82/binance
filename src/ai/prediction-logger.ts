import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ModelOutput, PredictionRecord } from './model-types';

const CSV_HEADER = [
  'timestamp', 'symbol', 'p_up', 'p_down', 'p_flat',
  'signal', 'mid_price', 'actual_outcome', 'actual_direction', 'outcome_filled_at',
].join(',');

export class PredictionLogger {
  private pending = new Map<number, PredictionRecord>();
  private readonly filePath: string;
  private headerWritten = false;

  constructor(outDir: string) {
    fs.mkdirSync(outDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    this.filePath = path.join(outDir, `predictions_${date}.csv`);
  }

  logPrediction(
    symbol: string,
    output: ModelOutput,
    signal: 'LONG' | 'SHORT' | 'HOLD',
    midPrice: number,
  ): number {
    const ts = Date.now();
    const record: PredictionRecord = {
      timestamp: ts,
      symbol,
      model_output: output,
      signal,
      mid_price: midPrice,
    };
    this.pending.set(ts, record);
    this.appendRow(record);
    return ts;
  }

  fillOutcome(predictionTs: number, actualReturn: number): void {
    const record = this.pending.get(predictionTs);
    if (!record) return;

    record.actual_outcome = actualReturn;
    record.actual_direction = actualReturn > 0.0004 ? 1 : actualReturn < -0.0004 ? -1 : 0;
    record.outcome_filled_at = Date.now();
    this.pending.delete(predictionTs);
    this.appendRow(record);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  pruneStale(maxAgeMs = 300_000): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [ts] of this.pending) {
      if (ts < cutoff) {
        this.pending.delete(ts);
        pruned += 1;
      }
    }
    return pruned;
  }

  private appendRow(r: PredictionRecord): void {
    if (!this.headerWritten) {
      if (!fs.existsSync(this.filePath)) {
        fs.writeFileSync(this.filePath, CSV_HEADER + '\n');
      }
      this.headerWritten = true;
    }
    const row = [
      r.timestamp,
      r.symbol,
      r.model_output.p_up.toFixed(4),
      r.model_output.p_down.toFixed(4),
      r.model_output.p_flat.toFixed(4),
      r.signal,
      r.mid_price,
      r.actual_outcome?.toFixed(6) ?? '',
      r.actual_direction ?? '',
      r.outcome_filled_at ?? '',
    ].join(',');
    fs.appendFileSync(this.filePath, row + '\n');
  }
}
