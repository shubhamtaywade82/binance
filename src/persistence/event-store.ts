import { DomainEvent } from '@coindcx/contracts';
import { EventBus } from '../core/events/event-bus';
import { PgWriter } from './pg-writer';

/**
 * EventStore — durable append-only log of domain events.
 *
 * Default persist filter excludes the firehose event types (market.trade,
 * market.depth.delta, market.bookticker, market.mark). Persisting them
 * trivially caused OOM after ~1h: 7 symbols × tens of trades/s × ~500B/event
 * exceeded the v8 4GB default heap before pg-writer could flush.
 *
 * The kept set is enough for deterministic replay of the trend-follower
 * (which only consults kline.closed) and full audit of risk/execution flow.
 */
const DEFAULT_PERSIST_TYPES: ReadonlySet<string> = new Set([
  'market.kline.closed',
  'strategy.signal',
  'execution.order.requested',
  'execution.order.requested.allocated',
  'execution.order.accepted',
  'execution.order.submitted',
  'execution.order.filled',
  'execution.order.rejected',
  'execution.position.close.requested',
  'execution.position.closed',
  'execution.position.close.failed',
  'trail.update',
  'risk.rejected',
]);

export class EventStore {
  private readonly persistTypes: ReadonlySet<string>;
  /** M-16: handle to the wildcard subscription so stop() can detach. */
  private subscription: { unsubscribe: () => void } | null = null;

  constructor(
    private readonly pgWriter: PgWriter,
    private readonly eventBus: EventBus,
    opts: { persistTypes?: Iterable<string> } = {},
  ) {
    this.persistTypes = opts.persistTypes ? new Set(opts.persistTypes) : DEFAULT_PERSIST_TYPES;
  }

  /** Subscribes to filtered event types and appends them to Postgres. */
  public startRecording(): void {
    if (this.subscription) return; // idempotent
    this.subscription = this.eventBus.subscribeAll((event) => {
      if (!this.persistTypes.has(event.type)) return;
      this.pgWriter
        .appendEvent({
          id: event.id,
          type: event.type,
          ts: event.ts,
          source: event.source,
          symbol: event.symbol,
          payload: event.payload,
        })
        .catch((err) => {
          console.error(`[EventStore] Failed to write event ${event.id}:`, err);
        });
    });
  }

  /**
   * M-16: detach the wildcard subscription so the EventBus doesn't hold a
   * reference to a half-shutdown PgWriter during graceful exit. Called by
   * the lifecycle registration in src/index.ts.
   */
  public stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  public async fetchEvents(
    fromTs: number,
    toTs: number,
    types?: string[],
  ): Promise<DomainEvent[]> {
    if (!this.pgWriter.pool) throw new Error('[EventStore] PgWriter is not connected.');

    let query = `SELECT id, type, ts, source, symbol, payload FROM events WHERE ts >= $1 AND ts <= $2`;
    const params: any[] = [fromTs, toTs];
    if (types && types.length > 0) {
      const typePlaceholders = types.map((_, i) => `$${i + 3}`).join(', ');
      query += ` AND type IN (${typePlaceholders})`;
      params.push(...types);
    }
    query += ` ORDER BY ts ASC`;

    const result = await this.pgWriter.pool.query(query, params);
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      ts: Number(row.ts),
      source: row.source,
      symbol: row.symbol ?? undefined,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    }));
  }
}
