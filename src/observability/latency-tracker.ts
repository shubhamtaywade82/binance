export interface LatencyRecord {
  orderId: string;
  symbol: string;
  sendTs: number;
  ackTs?: number;
  fillTs?: number;
  sendLatencyMs?: number;
  fillLatencyMs?: number;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { count: 0, p50: 0, p95: 0, p99: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: sum / sorted.length,
  };
}

export class LatencyTracker {
  private readonly maxRecords: number;
  private readonly records = new Map<string, LatencyRecord>();
  private readonly insertOrder: string[] = [];

  constructor(maxRecords = 1000) {
    this.maxRecords = maxRecords;
  }

  recordSend(orderId: string, symbol: string): void {
    this.evictIfNeeded();
    this.records.set(orderId, { orderId, symbol, sendTs: Date.now() });
    this.insertOrder.push(orderId);
  }

  recordAck(orderId: string): void {
    const rec = this.records.get(orderId);
    if (!rec) return;
    rec.ackTs = Date.now();
    rec.sendLatencyMs = rec.ackTs - rec.sendTs;
  }

  recordFill(orderId: string): void {
    const rec = this.records.get(orderId);
    if (!rec) return;
    rec.fillTs = Date.now();
    rec.fillLatencyMs = rec.fillTs - rec.sendTs;
  }

  sendLatencyStats(): LatencyStats {
    const vals: number[] = [];
    for (const rec of this.records.values()) {
      if (rec.sendLatencyMs !== undefined) vals.push(rec.sendLatencyMs);
    }
    return computeStats(vals);
  }

  fillLatencyStats(): LatencyStats {
    const vals: number[] = [];
    for (const rec of this.records.values()) {
      if (rec.fillLatencyMs !== undefined) vals.push(rec.fillLatencyMs);
    }
    return computeStats(vals);
  }

  getRecord(orderId: string): LatencyRecord | null {
    return this.records.get(orderId) ?? null;
  }

  private evictIfNeeded(): void {
    while (this.records.size >= this.maxRecords && this.insertOrder.length > 0) {
      const oldest = this.insertOrder.shift()!;
      this.records.delete(oldest);
    }
  }
}
