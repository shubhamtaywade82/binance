export type StreamName = 'depth' | 'trade' | 'markPrice' | 'funding';

interface StreamState {
  lastTs: number;
}

export class StreamAligner {
  private readonly streams = new Map<StreamName, StreamState>();

  constructor(streamNames: StreamName[] = ['depth', 'trade', 'markPrice', 'funding']) {
    for (const name of streamNames) {
      this.streams.set(name, { lastTs: 0 });
    }
  }

  update(stream: StreamName, ts: number): void {
    const state = this.streams.get(stream);
    if (!state) return;
    if (ts > state.lastTs) state.lastTs = ts;
  }

  isAligned(maxSkewMs: number): boolean {
    const timestamps = this.activeTimestamps();
    if (timestamps.length < 2) return true;
    const max = Math.max(...timestamps);
    const min = Math.min(...timestamps);
    return max - min <= maxSkewMs;
  }

  stalestStream(): { stream: string; ageMs: number } {
    const now = Date.now();
    let stalest: StreamName | null = null;
    let maxAge = -1;

    for (const [name, state] of this.streams) {
      if (state.lastTs === 0) return { stream: name, ageMs: now };
      const age = now - state.lastTs;
      if (age > maxAge) {
        maxAge = age;
        stalest = name;
      }
    }

    return { stream: stalest ?? 'unknown', ageMs: Math.max(0, maxAge) };
  }

  lastTimestamp(stream: StreamName): number {
    return this.streams.get(stream)?.lastTs ?? 0;
  }

  private activeTimestamps(): number[] {
    const ts: number[] = [];
    for (const state of this.streams.values()) {
      if (state.lastTs > 0) ts.push(state.lastTs);
    }
    return ts;
  }
}
