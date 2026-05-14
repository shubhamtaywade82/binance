import type { LocalOrderBook } from './orderbook';

export interface DepthChangeSnapshot {
  cancelIntensity: number;
  bookThinning: number;
  bidWallPersistence: number;
  askWallPersistence: number;
}

interface DepthRecord {
  ts: number;
  totalBidVol: number;
  totalAskVol: number;
  levelCount: number;
}

interface WallEntry {
  price: number;
  side: 'bid' | 'ask';
  firstSeen: number;
  lastSeen: number;
  qty: number;
}

export class DepthChangeTracker {
  private prevLevelCount = 0;
  private removals: number[] = [];
  private depthHistory: DepthRecord[] = [];
  private walls = new Map<string, WallEntry>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly wallMultiple = 5,
    private readonly levels = 20,
  ) {}

  update(book: LocalOrderBook): void {
    const now = Date.now();
    const { bids, asks } = book.topLevels(this.levels);
    const currentLevelCount = bids.length + asks.length;

    if (this.prevLevelCount > 0 && currentLevelCount < this.prevLevelCount) {
      this.removals.push(now);
    }
    this.prevLevelCount = currentLevelCount;

    const totalBidVol = bids.reduce((s, l) => s + l.qty, 0);
    const totalAskVol = asks.reduce((s, l) => s + l.qty, 0);
    this.depthHistory.push({ ts: now, totalBidVol, totalAskVol, levelCount: currentLevelCount });

    this.trackWalls(bids, 'bid', now);
    this.trackWalls(asks, 'ask', now);

    this.pruneOld(now);
  }

  snapshot(): DepthChangeSnapshot {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const recentRemovals = this.removals.filter((t) => t >= cutoff);
    const windowSec = this.windowMs / 1000;
    const cancelIntensity = windowSec > 0 ? recentRemovals.length / windowSec : 0;

    let bookThinning = 0;
    const recentDepth = this.depthHistory.filter((d) => d.ts >= cutoff);
    if (recentDepth.length >= 2) {
      const first = recentDepth[0];
      const last = recentDepth[recentDepth.length - 1];
      const firstTotal = first.totalBidVol + first.totalAskVol;
      const lastTotal = last.totalBidVol + last.totalAskVol;
      bookThinning = firstTotal > 0 ? (lastTotal - firstTotal) / firstTotal : 0;
    }

    let bidWallMs = 0;
    let bidWallCount = 0;
    let askWallMs = 0;
    let askWallCount = 0;
    for (const w of this.walls.values()) {
      const dur = w.lastSeen - w.firstSeen;
      if (w.side === 'bid') {
        bidWallMs += dur;
        bidWallCount++;
      } else {
        askWallMs += dur;
        askWallCount++;
      }
    }
    const bidWallPersistence = bidWallCount > 0 ? bidWallMs / bidWallCount / 1000 : 0;
    const askWallPersistence = askWallCount > 0 ? askWallMs / askWallCount / 1000 : 0;

    return { cancelIntensity, bookThinning, bidWallPersistence, askWallPersistence };
  }

  private trackWalls(
    levels: ReadonlyArray<{ price: number; qty: number }>,
    side: 'bid' | 'ask',
    now: number,
  ): void {
    const avgQty = levels.length > 0
      ? levels.reduce((s, l) => s + l.qty, 0) / levels.length
      : 0;
    const threshold = avgQty * this.wallMultiple;

    const activeKeys = new Set<string>();
    for (const lvl of levels) {
      if (lvl.qty < threshold) continue;
      const key = `${side}:${lvl.price}`;
      activeKeys.add(key);
      const existing = this.walls.get(key);
      if (existing) {
        existing.lastSeen = now;
        existing.qty = lvl.qty;
      } else {
        this.walls.set(key, { price: lvl.price, side, firstSeen: now, lastSeen: now, qty: lvl.qty });
      }
    }

    for (const [key, entry] of this.walls) {
      if (entry.side === side && !activeKeys.has(key)) {
        this.walls.delete(key);
      }
    }
  }

  private pruneOld(now: number): void {
    const cutoff = now - this.windowMs * 2;
    this.removals = this.removals.filter((t) => t >= cutoff);
    while (this.depthHistory.length > 0 && this.depthHistory[0].ts < cutoff) {
      this.depthHistory.shift();
    }
  }
}
