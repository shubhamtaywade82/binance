import { DomainEvent } from '@coindcx/contracts';
import { EventBus } from '../core/events/event-bus';
import { PgWriter } from './pg-writer';

export class EventStore {
  constructor(
    private readonly pgWriter: PgWriter,
    private readonly eventBus: EventBus
  ) {}

  /**
   * Subscribes to all events on the provided EventBus and appends them
   * to the persistent event store.
   */
  public startRecording(): void {
    this.eventBus.subscribeAll((event) => {
      this.pgWriter.appendEvent({
        id: event.id,
        type: event.type,
        ts: event.ts,
        source: event.source,
        symbol: event.symbol,
        payload: event.payload,
      }).catch(err => {
        console.error(`[EventStore] Failed to write event ${event.id}:`, err);
      });
    });
  }

  /**
   * Retrieves events from the persistent store, ordered by timestamp ascending.
   * Useful for the Deterministic Replay Engine.
   */
  public async fetchEvents(
    fromTs: number,
    toTs: number,
    types?: string[]
  ): Promise<DomainEvent[]> {
    if (!this.pgWriter.pool) {
      throw new Error('[EventStore] PgWriter is not connected.');
    }

    let query = `SELECT id, type, ts, source, symbol, payload FROM events WHERE ts >= $1 AND ts <= $2`;
    const params: any[] = [fromTs, toTs];

    if (types && types.length > 0) {
      const typePlaceholders = types.map((_, i) => `$${i + 3}`).join(', ');
      query += ` AND type IN (${typePlaceholders})`;
      params.push(...types);
    }

    query += ` ORDER BY ts ASC`;

    const result = await this.pgWriter.pool.query(query, params);
    return result.rows.map(row => ({
      id: row.id,
      type: row.type,
      ts: Number(row.ts),
      source: row.source,
      symbol: row.symbol ?? undefined,
      payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    }));
  }
}
