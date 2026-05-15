import type Redis from 'ioredis';
import type { WalletState } from '../execution/paper/wallet';

/**
 * RedisPaperStateStore — write-through cache for paper-trading runtime state.
 *
 * What lives here:
 *   paper:wallet                 hash; updated every onMark
 *   paper:positions              hash<orderId, JSON>; updated on fill / close
 *   paper:equity     (stream)    XADD MAXLEN ~10000, one entry per snapshot
 *   paper:last_marks             hash<symbol, price>; last seen mark per symbol
 *
 * Why: ./paper/equity.jsonl was the only ledger of runtime equity snapshots
 * (every 5s) and grew unbounded. Postgres equity_snapshots is the durable
 * 1/min record; Redis is the hot 5s tail that the dashboard reads.
 *
 * On graceful shutdown the wallet is also flushed to disk; on cold start the
 * adapter still loads ./paper/wallet.json first then this store overwrites
 * with whatever Redis has if Redis is fresher (newer updatedAt).
 */
export class RedisPaperStateStore {
  private readonly walletKey: string;
  private readonly positionsKey: string;
  private readonly equityStream: string;
  private readonly marksKey: string;
  private readonly pubsubPrefix: string;
  private static readonly STREAM_MAX_LEN = 10_000;

  constructor(private readonly redis: Redis, namespace = 'binance') {
    const ns = namespace.replace(/:+$/, '');
    this.walletKey = `${ns}:paper:wallet`;
    this.positionsKey = `${ns}:paper:positions`;
    this.equityStream = `${ns}:paper:equity`;
    this.marksKey = `${ns}:paper:last_marks`;
    this.pubsubPrefix = `${ns}:paper:updates`;
  }

  async setWallet(state: WalletState): Promise<void> {
    try {
      await this.redis.hset(this.walletKey, {
        balanceUsdt: state.balanceUsdt,
        availableUsdt: state.availableUsdt,
        usedMarginUsdt: state.usedMarginUsdt,
        unrealizedPnlUsdt: state.unrealizedPnlUsdt,
        realizedPnlUsdt: state.realizedPnlUsdt,
        equityUsdt: state.equityUsdt,
        updatedAt: state.updatedAt,
      });
    } catch {
      // best-effort
    }
  }

  async getWallet(): Promise<Partial<WalletState> | null> {
    try {
      const row = await this.redis.hgetall(this.walletKey);
      if (!row || Object.keys(row).length === 0) return null;
      return {
        balanceUsdt: Number(row.balanceUsdt),
        availableUsdt: Number(row.availableUsdt),
        usedMarginUsdt: Number(row.usedMarginUsdt),
        unrealizedPnlUsdt: Number(row.unrealizedPnlUsdt),
        realizedPnlUsdt: Number(row.realizedPnlUsdt),
        equityUsdt: Number(row.equityUsdt),
        updatedAt: Number(row.updatedAt),
      };
    } catch {
      return null;
    }
  }

  async upsertPosition(orderId: string, payload: object): Promise<void> {
    try {
      await this.redis.hset(this.positionsKey, orderId, JSON.stringify(payload));
    } catch {
      // best-effort
    }
  }

  async removePosition(orderId: string): Promise<void> {
    try {
      await this.redis.hdel(this.positionsKey, orderId);
    } catch {
      // best-effort
    }
  }

  async getPositions(): Promise<Array<Record<string, unknown>>> {
    try {
      const row = await this.redis.hgetall(this.positionsKey);
      return Object.values(row || {}).map((v) => {
        try { return JSON.parse(String(v)); } catch { return {}; }
      });
    } catch {
      return [];
    }
  }

  async appendEquity(point: { ts: number; equityUsdt: number; balanceUsdt: number; unrealizedPnlUsdt: number; realizedPnlUsdt: number; usedMarginUsdt: number; inrPerUsdt?: number }): Promise<void> {
    try {
      await this.redis.xadd(
        this.equityStream,
        'MAXLEN', '~', String(RedisPaperStateStore.STREAM_MAX_LEN),
        '*',
        'ts', String(point.ts),
        'equityUsdt', String(point.equityUsdt),
        'balanceUsdt', String(point.balanceUsdt),
        'unrealizedPnlUsdt', String(point.unrealizedPnlUsdt),
        'realizedPnlUsdt', String(point.realizedPnlUsdt),
        'usedMarginUsdt', String(point.usedMarginUsdt),
        'inrPerUsdt', String(point.inrPerUsdt ?? ''),
      );
    } catch {
      // best-effort
    }
  }

  /** Publish a NOTIFY-like pubsub channel for external listeners (FastAPI / UI). */
  async publishUpdate(kind: 'wallet' | 'position' | 'equity', payload: object): Promise<void> {
    try {
      await this.redis.publish(`${this.pubsubPrefix}:${kind}`, JSON.stringify({ kind, ts: Date.now(), ...payload }));
    } catch {
      // best-effort
    }
  }

  async setMark(symbol: string, price: number): Promise<void> {
    try {
      await this.redis.hset(this.marksKey, symbol.toUpperCase(), String(price));
    } catch {
      // best-effort
    }
  }
}
