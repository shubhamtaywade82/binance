import { DomainEvent } from '@coindcx/contracts';
import { EventBus } from '../core/events/event-bus';
import { EventStore } from '../persistence/event-store';
import { MarketClock, marketClock as defaultClock } from '../core/time/market-clock';

export interface ReplayOptions {
  fromTs: number;
  toTs: number;
  /** Restrict to a subset of event types. Default: all. */
  types?: string[];
  /**
   * Time scale:
   *   1       — wall-clock speed
   *   N > 1   — fast-forward (100 = 100×)
   *   0 or Infinity — as fast as possible (immediate dispatch, preserves order only)
   */
  speedMultiplier?: number;
  onProgress?: (event: DomainEvent, idx: number, total: number) => void;
}

/**
 * ReplayEngine — deterministic playback of historical events.
 *
 * Reads events from the EventStore in ts-ascending order, sets MarketClock
 * to the event's ts BEFORE publishing, then republishes onto the same
 * EventBus the live system uses. Strategies / risk / execution see identical
 * inputs as live → same outputs (when pure).
 */
export class ReplayEngine {
  private readonly clock: MarketClock;

  constructor(
    private readonly eventStore: EventStore,
    private readonly eventBus: EventBus,
    clock: MarketClock = defaultClock,
  ) {
    this.clock = clock;
  }

  public async replay(options: ReplayOptions): Promise<{ dispatched: number; durationMs: number }> {
    const events = await this.eventStore.fetchEvents(options.fromTs, options.toTs, options.types);
    if (events.length === 0) return { dispatched: 0, durationMs: 0 };

    const speed = options.speedMultiplier ?? 1;
    const fast = !isFinite(speed) || speed <= 0;
    const startWall = Date.now();
    const startEvent = events[0].ts;

    this.clock.setMode('replay');
    try {
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!fast) {
          const elapsedEvent = ev.ts - startEvent;
          const targetWall = startWall + elapsedEvent / speed;
          const wait = targetWall - Date.now();
          if (wait > 0) await delay(wait);
        }
        this.clock.setReplayTs(ev.ts);
        this.eventBus.publish(ev);
        options.onProgress?.(ev, i, events.length);
      }
    } finally {
      this.clock.setMode('live');
    }

    return { dispatched: events.length, durationMs: Date.now() - startWall };
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
