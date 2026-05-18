import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Subset of fill metadata that the event-bus exit managers (trailing stop,
 * tp ladder, structure exit, time stop) need to fully re-arm on restart.
 * Keep this minimal — anything we forget here forces exit managers to fall
 * back to defaults after a crash, which is safe but less precise than the
 * original strategy intent.
 */
export interface FillMetadata {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  price: number;
  /** Initial stop price (from strategy intent) — used by trail manager. */
  stopLoss?: number;
  /** Initial take-profit price — used by TP ladder + trail. */
  takeProfit?: number;
  /** Strategy id that produced the fill, for logging. */
  strategyId?: string;
  /** Optional partial-TP ladder. */
  tpLadder?: Array<{ price: number; pct: number }>;
  /** Optional "max holding bars". */
  maxHoldBars?: number;
  /** Optional regime/mode tag for adaptive strategies. */
  regime?: string;
  modeId?: string;
  /** Optional ATR at entry — used by trail manager for chandelier exit math. */
  atrAtEntry?: number;
  /** When the fill happened. */
  openedAt: number;
}

/**
 * FillMetadataStore — atomic, file-backed metadata store keyed by orderId.
 *
 * The PgWriter logs every event to its WAL (C-8) but that's payload-centric;
 * the exit managers care about derived metadata (atr, tp ladder, regime)
 * that we want to recover quickly on boot without grepping the full WAL.
 *
 * Format: a single JSON object `{ [orderId]: FillMetadata }` written via
 * tmp + rename so a kill -9 between write() and rename() leaves the
 * previous-good file intact.
 */
export class FillMetadataStore {
  private readonly filePath: string;
  private map = new Map<string, FillMetadata>();

  constructor(filePath: string) {
    this.filePath = filePath;
    const dir = path.dirname(filePath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  /** Re-read the file from disk. Called automatically by constructor. */
  load(): void {
    this.map.clear();
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(raw) as Record<string, FillMetadata>;
      for (const [k, v] of Object.entries(parsed)) {
        this.map.set(k, v);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[fill-metadata] could not parse ${this.filePath}: ${(err as Error).message}`);
    }
  }

  upsert(meta: FillMetadata): void {
    this.map.set(meta.orderId, meta);
    this.flush();
  }

  remove(orderId: string): void {
    if (this.map.delete(orderId)) this.flush();
  }

  get(orderId: string): FillMetadata | undefined {
    return this.map.get(orderId);
  }

  all(): FillMetadata[] {
    return Array.from(this.map.values());
  }

  bySymbol(symbol: string): FillMetadata[] {
    return this.all().filter((m) => m.symbol === symbol);
  }

  /** Atomic file replace: write to tmp, then rename. */
  private flush(): void {
    const obj: Record<string, FillMetadata> = {};
    for (const [k, v] of this.map.entries()) obj[k] = v;
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}
