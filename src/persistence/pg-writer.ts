import { Pool, type PoolConfig } from 'pg';
import type { ClosedPosition } from '../execution/types';

export interface PgWriterOptions {
  connectionString: string;
  maxPoolSize?: number;
  batchSize?: number;
  flushIntervalMs?: number;
}

export class PgWriter {
  public pool: Pool | null = null;
  private connected = false;

  private eventQueue: any[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(private readonly opts: PgWriterOptions) {
    this.batchSize = opts.batchSize ?? 100;
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
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
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO positions (order_id, symbol, side, qty, entry_price, leverage, margin_usdt, liq_price, opened_at, updated_at, unrealized_pnl, mark_price, tier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
           tier = EXCLUDED.tier`,
        [
          p.orderId, p.symbol, p.side, p.quantity, p.entryPrice, p.leverage,
          p.marginUsdt, p.liqPrice, p.openedAt, Date.now(), p.unrealizedPnl ?? 0, p.markPrice ?? null, p.tier ?? null
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

  async appendEvent(e: {
    id: string;
    type: string;
    ts: number;
    source: string;
    symbol?: string;
    payload: unknown;
  }): Promise<void> {
    if (!this.pool) return;

    this.eventQueue.push(e);

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
    } catch (err) {
      console.warn('[pg-writer] flushEvents failed:', (err as Error).message);
      // Put back in queue? Or just log? 
      // If it's a constraint error, retry might fail forever.
      // For now, just log to prevent infinite loops.
    }
  }
}
