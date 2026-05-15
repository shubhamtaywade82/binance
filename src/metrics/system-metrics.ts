export interface SystemMetricsSnapshot {
  wsMessageLag: number;
  wsReconnects: number;
  errorsPerMinute: number;
  uptimeMs: number;
}

const LAG_RING_SIZE = 100;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

export class SystemMetricsTracker {
  private readonly startTs: number;

  private readonly lagRing: number[] = [];
  private lagIdx = 0;
  private lagCount = 0;
  private lagSum = 0;

  private readonly reconnectTimestamps: number[] = [];
  private readonly errorTimestamps: number[] = [];

  constructor() {
    this.startTs = Date.now();
  }

  recordWsLag(eventTs: number, processTs: number): void {
    const lag = processTs - eventTs;

    if (this.lagCount < LAG_RING_SIZE) {
      this.lagRing.push(lag);
      this.lagSum += lag;
      this.lagCount++;
    } else {
      this.lagSum -= this.lagRing[this.lagIdx];
      this.lagRing[this.lagIdx] = lag;
      this.lagSum += lag;
      this.lagIdx = (this.lagIdx + 1) % LAG_RING_SIZE;
    }
  }

  recordWsReconnect(): void {
    this.reconnectTimestamps.push(Date.now());
  }

  recordError(): void {
    this.errorTimestamps.push(Date.now());
  }

  snapshot(): SystemMetricsSnapshot {
    const now = Date.now();
    this.pruneOlderThan(this.reconnectTimestamps, now - ONE_HOUR_MS);
    this.pruneOlderThan(this.errorTimestamps, now - ONE_MINUTE_MS);

    return {
      wsMessageLag: this.lagCount > 0 ? this.lagSum / this.lagCount : 0,
      wsReconnects: this.reconnectTimestamps.length,
      errorsPerMinute: this.errorTimestamps.length,
      uptimeMs: now - this.startTs,
    };
  }

  private pruneOlderThan(timestamps: number[], cutoff: number): void {
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  }
}
