import { Pool, type PoolConfig } from 'pg';
import type { ClosedPosition } from '../execution/types';
import { EventWal, type WalEvent } from './event-wal';

export interface PgWriterOptions {
  connectionString: string;
  maxPoolSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  /**
   * C-8: path to a local write-ahead log file. When set, every event passed
   * to appendEvent is durably written to this file before being enqueued for
   * Postgres. The file is replayed on startup so events that landed on disk
   * but not yet in Postgres survive a crash. When unset, the WAL is disabled
   * and the legacy in-memory-only path runs (data-loss risk on overflow).
   */
  walPath?: string;
  /** Compact the WAL after the in-mem flushed set reaches this size. Default 500. */
  walCompactAfter?: number;
}

export class PgWriter {
  public pool: Pool | null = null;
  private connected = false;

  private eventQueue: any[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly wal: EventWal | null;
  private readonly walCompactAfter: number;
  /** IDs that have been ACK'd by Postgres and are safe to drop from the WAL. */
  private flushedIds = new Set<string>();

  constructor(private readonly opts: PgWriterOptions) {
    this.batchSize = opts.batchSize ?? 100;
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
    this.wal = opts.walPath ? new EventWal(opts.walPath) : null;
    this.walCompactAfter = opts.walCompactAfter ?? 500;
  }

  async connect(): Promise<void> {
    try {
      const config: PoolConfig = {
        connectionString: this.opts.connectionString,
        max: this.opts.maxPoolSize ?? 20, // Increased default from 5 to 20
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      };
      this.pool = new Pool(config);
      await this.pool.query('SELECT 1');
      this.connected = true;

      // C-8: replay any pre-crash WAL entries into the queue BEFORE we start
      // the periodic flusher, so an interrupted run resumes from disk-durable
      // state. ON CONFLICT (id) DO NOTHING in flushEvents() makes the replay
      // idempotent if Postgres already saw some of them.
      if (this.wal) {
        this.wal.open();
        const replay = this.wal.replayAll((line, err) => {
          // eslint-disable-next-line no-console
          console.warn(`[pg-writer] WAL skip corrupt line (${err.message}): ${line.slice(0, 80)}`);
        });
        if (replay.length > 0) {
          // eslint-disable-next-line no-console
          console.warn(`[pg-writer] replaying ${replay.length} events from WAL`);
          for (const e of replay) this.eventQueue.push(e);
          await this.flushEvents();
        }
      }

      // Start periodic flush
      this.flushTimer = setInterval(() => this.flushEvents(), this.flushIntervalMs);
    } catch (err) {
      console.warn('[pg-writer] Failed to connect to PostgreSQL, persistence disabled:', (err as Error).message);
      this.pool = null;
      this.connected = false;
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush before closing
    await this.flushEvents();

    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
    }
    if (this.wal) this.wal.close();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ... (writeTrade, upsertPosition, etc. remain unchanged)
  async writeTrade(t: ClosedPosition, symbol: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO trades (order_id, timestamp_ms, symbol, side, leverage, qty, entry_price, exit_price, gross_pnl, fees, funding, net_pnl, close_reason, opened_at, closed_at, attribution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (order_id) DO NOTHING`,
        [
          t.orderId,
          t.closedAt,
          symbol,
          t.side,
          t.leverage,
          t.quantity,
          t.entryPrice,
          t.exitPrice,
          t.grossUsdt,
          t.feesUsdt,
          t.fundingUsdt,
          t.netUsdt,
          t.reason,
          t.openedAt,
          t.closedAt,
          t.attribution ? JSON.stringify(t.attribution) : null,
        ]
      );
    } catch (err) {
      console.warn('[pg-writer] writeTrade failed:', (err as Error).message);
    }
  }

  async upsertPosition(p: {
    orderId: string;
    symbol: string;
    side: string;
    quantity: number;
    entryPrice: number;
    leverage: number;
    marginUsdt: number;
    liqPrice: number;
    openedAt: number;
    unrealizedPnl?: number;
    markPrice?: number;
    tier?: string;
    mode?: string;
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO positions (order_id, symbol, side, qty, entry_price, leverage, margin_usdt, liq_price, opened_at, updated_at, unrealized_pnl, mark_price, tier, mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (symbol) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           side = EXCLUDED.side,
           qty = EXCLUDED.qty,
           entry_price = EXCLUDED.entry_price,
           leverage = EXCLUDED.leverage,
           margin_usdt = EXCLUDED.margin_usdt,
           liq_price = EXCLUDED.liq_price,
           opened_at = EXCLUDED.opened_at,
           unrealized_pnl = EXCLUDED.unrealized_pnl,
           mark_price = EXCLUDED.mark_price,
           updated_at = EXCLUDED.updated_at,
           tier = EXCLUDED.tier,
           mode = EXCLUDED.mode`,
        [
          p.orderId, p.symbol, p.side, p.quantity, p.entryPrice, p.leverage,
          p.marginUsdt, p.liqPrice, p.openedAt, Date.now(), p.unrealizedPnl ?? 0, p.markPrice ?? null, p.tier ?? null, p.mode ?? 'paper'
        ]
      );
    } catch (err) {
      console.warn('[pg-writer] upsertPosition failed:', (err as Error).message);
    }
  }

  async removePosition(orderId: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query('DELETE FROM positions WHERE order_id = $1', [orderId]);
    } catch (err) {
      console.warn('[pg-writer] removePosition failed:', (err as Error).message);
    }
  }

  async removePositionBySymbol(symbol: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query('DELETE FROM positions WHERE symbol = $1', [symbol]);
    } catch (err) {
      console.warn('[pg-writer] removePositionBySymbol failed:', (err as Error).message);
    }
  }

  async writeEquitySnapshot(s: {
    balanceUsdt: number;
    equityUsdt: number;
    usedMarginUsdt: number;
    unrealizedPnlUsdt: number;
    realizedPnlUsdt: number;
  }, drawdown: number, openPositionCount: number, inrPerUsdt?: number): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO equity_snapshots (ts, balance, equity, used_margin, unrealized_pnl, realized_pnl, drawdown, open_positions, inr_per_usdt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (ts) DO NOTHING`,
        [Date.now(), s.balanceUsdt, s.equityUsdt, s.usedMarginUsdt, s.unrealizedPnlUsdt, s.realizedPnlUsdt, drawdown, openPositionCount, inrPerUsdt ?? null]
      );
    } catch (err) {
      console.warn('[pg-writer] writeEquitySnapshot failed:', (err as Error).message);
    }
  }

  async writeOrder(o: {
    orderId: string;
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    status: string;
    fillPrice?: number;
    feeUsdt?: number;
    slippageUsdt?: number;
    latencyMs?: number;
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO orders (order_id, timestamp_ms, symbol, side, qty, price, status, fill_price, fee_usdt, slippage_usdt, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [o.orderId, Date.now(), o.symbol, o.side, o.quantity, o.price, o.status, o.fillPrice ?? null, o.feeUsdt ?? null, o.slippageUsdt ?? null, o.latencyMs ?? null]
      );
    } catch (err) {
      console.warn('[pg-writer] writeOrder failed:', (err as Error).message);
    }
  }

  async writePrediction(p: {
    symbol: string;
    pUp: number;
    pDown: number;
    regime?: string;
    signal?: string;
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO predictions (timestamp_ms, symbol, p_up, p_down, regime, signal)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [Date.now(), p.symbol, p.pUp, p.pDown, p.regime ?? null, p.signal ?? null]
      );
    } catch (err) {
      console.warn('[pg-writer] writePrediction failed:', (err as Error).message);
    }
  }

  /** Hard cap to prevent OOM when Postgres falls behind. Drops oldest on overflow. */
  private readonly queueMaxLen = Number(process.env.PG_WRITER_QUEUE_MAX || 10_000);
  private droppedEvents = 0;

  async appendEvent(e: {
    id: string;
    type: string;
    ts: number;
    source: string;
    symbol?: string;
    payload: unknown;
  }): Promise<void> {
    if (!this.pool) return;

    // C-8: write to WAL FIRST. Event is durable on disk before the in-mem
    // queue mutates. If the in-mem queue overflows and drops events, the WAL
    // still has them and they'll be replayed on next start.
    if (this.wal) {
      try {
        this.wal.append(e as WalEvent);
      } catch (err) {
        // WAL write failure is loud — disk full or fs error. We still try to
        // enqueue in memory so the event might survive the rest of the run,
        // but the operator needs to know durability is broken.
        // eslint-disable-next-line no-console
        console.error('[pg-writer] WAL append failed:', (err as Error).message);
      }
    }

    this.eventQueue.push(e);

    if (this.eventQueue.length > this.queueMaxLen) {
      // Backpressure: drop oldest from the IN-MEM queue. With the WAL enabled,
      // these events are still on disk and will be replayed on next start;
      // without the WAL, this is irrecoverable data loss.
      const drop = this.eventQueue.length - this.queueMaxLen;
      this.eventQueue.splice(0, drop);
      this.droppedEvents += drop;
      if (this.droppedEvents % 1000 < drop) {
        const recoveryHint = this.wal
          ? '(WAL has them; retry on next start)'
          : '(NO WAL — data lost; set walPath to enable recovery)';
        console.warn(`[pg-writer] event queue saturated; dropped ${this.droppedEvents} events total ${recoveryHint}`);
      }
    }

    if (this.eventQueue.length >= this.batchSize) {
      this.flushEvents().catch(err => {
        console.warn('[pg-writer] background flush failed:', err.message);
      });
    }
  }

  private async flushEvents(): Promise<void> {
    if (!this.pool || this.eventQueue.length === 0) return;

    const toFlush = [...this.eventQueue];
    this.eventQueue = [];

    try {
      // Chunk batch into smaller pieces if necessary to stay within PG parameter limits (max 65535)
      // Each event has 6 fields. 100 events = 600 parameters. Batch size of 100 is safe.
      const queryParts: string[] = [];
      const values: any[] = [];
      let paramIdx = 1;

      for (const e of toFlush) {
        queryParts.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
        values.push(e.id, e.type, e.ts, e.source, e.symbol ?? null, JSON.stringify(e.payload));
      }

      const sql = `INSERT INTO events (id, type, ts, source, symbol, payload)
                   VALUES ${queryParts.join(', ')}
                   ON CONFLICT (id) DO NOTHING`;

      await this.pool.query(sql, values);

      // C-8: events successfully flushed → eligible to drop from WAL on next
      // compaction. We compact when the flushed-id set grows past the
      // configured threshold to amortise file-rewrite cost.
      if (this.wal) {
        for (const e of toFlush) this.flushedIds.add(e.id);
        if (this.flushedIds.size >= this.walCompactAfter) {
          try {
            const flushed = this.flushedIds;
            this.flushedIds = new Set();
            this.wal.compact((e) => !flushed.has(e.id));
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[pg-writer] WAL compact failed:', (err as Error).message);
          }
        }
      }
    } catch (err) {
      // PG flush failed: put events back in queue so the next flush retries.
      // The WAL still holds them, so even a process crash here is recoverable.
      this.eventQueue.unshift(...toFlush);
      // eslint-disable-next-line no-console
      console.warn('[pg-writer] flushEvents failed (re-queued):', (err as Error).message);
    }
  }
}
