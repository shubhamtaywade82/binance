import * as fs from 'node:fs';
import * as path from 'node:path';
import { featureVectorCsvHeader, featureVectorToCsvRow, type FeatureVector } from './feature-schema';

export class FeatureRecorder {
  private buffer: string[] = [];
  private headerWritten = false;
  private currentPath: string;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly outDir: string,
    private readonly flushIntervalMs = 5_000,
    private readonly maxBufferSize = 500,
  ) {
    this.currentPath = this.buildPath();
  }

  start(): void {
    if (this.flushTimer) return;
    fs.mkdirSync(this.outDir, { recursive: true });
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  record(fv: FeatureVector): void {
    this.buffer.push(featureVectorToCsvRow(fv));
    if (this.buffer.length >= this.maxBufferSize) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;

    const filePath = this.currentPath;

    if (!this.headerWritten || !fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, featureVectorCsvHeader() + '\n', { flag: 'a' });
      this.headerWritten = true;
    }

    fs.appendFileSync(filePath, this.buffer.join('\n') + '\n');
    this.buffer = [];
  }

  rotatePath(): void {
    this.flush();
    this.currentPath = this.buildPath();
    this.headerWritten = false;
  }

  private buildPath(): string {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(this.outDir, `features_${date}.csv`);
  }
}
