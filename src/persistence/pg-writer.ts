import { Pool, type PoolConfig } from 'pg';

export interface PgWriterOptions {
  connectionString: string;
  maxPoolSize?: number;
}

export class PgWriter {
  private pool: Pool | null = null;
  private connected = false;

  constructor(private readonly opts: PgWriterOptions) {}

  async connect(): Promise<void> {
    try {
      const config: PoolConfig = {
        connectionString: this.opts.connectionString,
        max: this.opts.maxPoolSize ?? 5,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      };
      this.pool = new Pool(config);
      await this.pool.query('SELECT 1');
      this.connected = true;
    } catch (err) {
      console.warn('[pg-writer] Failed to connect to PostgreSQL, persistence disabled:', (err as Error).message);
      this.pool = null;
      this.connected = false;
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async writeTrade(t: {
    orderId: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    reason: string;
    grossUsdt: number;
    feesUsdt: number;
    fundingUsdt: number;
    netUsdt: number;
    openedAt: number;
    closedAt: number;
    attribution?: object;
  }, symbol: string): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO trades (order_id, timestamp_ms, symbol, side, qty, entry_price, exit_price, gross_pnl, fees, funding, net_pnl, close_reason, opened_at, closed_at, attribution)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (order_id) DO NOTHING`,
        [t.orderId, t.closedAt, symbol, t.side, t.quantity, t.entryPrice, t.exitPrice, t.grossUsdt, t.feesUsdt, t.fundingUsdt, t.netUsdt, t.reason, t.openedAt, t.closedAt, t.attribution ? JSON.stringify(t.attribution) : null]
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
  }): Promise<void> {
    if (!this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO positions (order_id, symbol, side, qty, entry_price, leverage, margin_usdt, liq_price, opened_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (order_id) DO UPDATE SET
           unrealized_pnl = EXCLUDED.unrealized_pnl,
           updated_at = EXCLUDED.updated_at`,
        [p.orderId, p.symbol, p.side, p.quantity, p.entryPrice, p.leverage, p.marginUsdt, p.liqPrice, p.openedAt, Date.now()]
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
}
