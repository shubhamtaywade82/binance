import { DomainEvent } from '@coindcx/contracts';

type EventCallback<T = any> = (event: DomainEvent<T>) => void | Promise<void>;

export interface Subscription {
  unsubscribe: () => void;
}

export interface AsyncSubscribeOptions {
  /**
   * Soft queue-depth warning threshold. When the per-subscriber queue exceeds
   * this length, a high-water-mark log fires (rate-limited to one log per
   * crossing). Default 100.
   */
  queueWarnThreshold?: number;
  /**
   * Consecutive callback errors before the subscriber is considered "dead"
   * and the offending event is re-published on `dead_letter`. Default 5.
   */
  maxConsecutiveErrors?: number;
  /** Optional tag shown in queue-depth warnings + dead-letter payloads. */
  name?: string;
}

interface AsyncSubscriberState {
  cb: EventCallback;
  queue: DomainEvent[];
  draining: boolean;
  consecutiveErrors: number;
  queueWarnThreshold: number;
  maxConsecutiveErrors: number;
  highWaterLogged: boolean;
  name: string;
}

/**
 * EventBus — in-process pub/sub fabric.
 *
 * Two dispatch modes:
 *
 *   subscribe(type, cb)
 *     Synchronous routing path. Callbacks fire inside the publisher's call
 *     stack. Use this for state machines and bridges where downstream events
 *     depend on completing the upstream side-effects first (RiskEngine →
 *     ExecutionBridge, SignalAllocator → RiskEngine, FreshnessWatchdog).
 *
 *   subscribeAsync(type, cb, opts?)
 *     Per-subscriber FIFO queue drained on setImmediate. Publishers never
 *     block on these. Use for side-effect sinks that touch the network /
 *     disk (TelegramNotifier, EventStore → Postgres, dashboard fan-out).
 *
 *     If `maxConsecutiveErrors` consecutive callback invocations throw or
 *     reject, the offending event is republished as `dead_letter` with the
 *     original payload + error meta so an operator subscriber can surface
 *     it. The subscriber's queue is then cleared and the failure counter
 *     reset — the subscriber resumes processing future events.
 *
 *     When the queue exceeds `queueWarnThreshold`, a `eventbus_async_queue_high_water`
 *     event is published exactly once per crossing (re-armed once the queue
 *     drops back below the threshold).
 */
export class EventBus {
  private subscribers: Map<string, Set<EventCallback>> = new Map();
  private asyncSubscribers: Map<string, Set<AsyncSubscriberState>> = new Map();
  private wildcardSubscribers: Set<EventCallback> = new Set();
  private errorHandler: (err: Error, event: DomainEvent) => void;

  constructor(errorHandler?: (err: Error, event: DomainEvent) => void) {
    this.errorHandler = errorHandler || ((err, event) => {
      // eslint-disable-next-line no-console
      console.error(`[EventBus] Error processing event ${event.type} (${event.id}):`, err);
    });
  }

  public subscribe<T>(eventType: string, callback: EventCallback<T>): Subscription {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    this.subscribers.get(eventType)!.add(callback as EventCallback);

    return {
      unsubscribe: () => {
        const subs = this.subscribers.get(eventType);
        if (subs) {
          subs.delete(callback as EventCallback);
          if (subs.size === 0) {
            this.subscribers.delete(eventType);
          }
        }
      }
    };
  }

  /**
   * Register a queued, asynchronous subscriber. Publishers never block on it;
   * its work runs on setImmediate. See class docstring for failure semantics.
   */
  public subscribeAsync<T>(
    eventType: string,
    callback: EventCallback<T>,
    opts: AsyncSubscribeOptions = {},
  ): Subscription {
    const state: AsyncSubscriberState = {
      cb: callback as EventCallback,
      queue: [],
      draining: false,
      consecutiveErrors: 0,
      queueWarnThreshold: opts.queueWarnThreshold ?? 100,
      maxConsecutiveErrors: opts.maxConsecutiveErrors ?? 5,
      highWaterLogged: false,
      name: opts.name ?? `${eventType}-async`,
    };
    if (!this.asyncSubscribers.has(eventType)) {
      this.asyncSubscribers.set(eventType, new Set());
    }
    this.asyncSubscribers.get(eventType)!.add(state);

    return {
      unsubscribe: () => {
        const set = this.asyncSubscribers.get(eventType);
        if (!set) return;
        set.delete(state);
        if (set.size === 0) this.asyncSubscribers.delete(eventType);
      },
    };
  }

  public subscribeAll(callback: EventCallback): Subscription {
    this.wildcardSubscribers.add(callback);
    return {
      unsubscribe: () => {
        this.wildcardSubscribers.delete(callback);
      }
    };
  }

  public publish(event: DomainEvent): void {
    // Wildcard subscribers (sync) — kept for backwards compat with SymbolActor.
    for (const callback of this.wildcardSubscribers) {
      this.invokeCallback(callback, event);
    }

    // Specific-type sync subscribers.
    const subs = this.subscribers.get(event.type);
    if (subs) {
      for (const callback of subs) {
        this.invokeCallback(callback, event);
      }
    }

    // Per-subscriber async queues. Push and schedule drain; never block.
    const asyncSubs = this.asyncSubscribers.get(event.type);
    if (asyncSubs) {
      for (const state of asyncSubs) {
        state.queue.push(event);
        if (state.queue.length > state.queueWarnThreshold && !state.highWaterLogged) {
          state.highWaterLogged = true;
          // Emit a system event so observability sinks (logger / metrics) can
          // alert without coupling EventBus to a concrete logger.
          this.publish({
            id: `eventbus-hw-${state.name}-${event.ts}`,
            type: 'eventbus.async_queue_high_water',
            ts: event.ts,
            source: 'event-bus',
            payload: {
              subscriber: state.name,
              eventType: event.type,
              queueDepth: state.queue.length,
              threshold: state.queueWarnThreshold,
            },
          });
        }
        if (!state.draining) {
          state.draining = true;
          setImmediate(() => this.drain(state));
        }
      }
    }
  }

  private invokeCallback(callback: EventCallback, event: DomainEvent): void {
    try {
      const result = callback(event);
      if (result instanceof Promise) {
        result.catch(err => this.errorHandler(err, event));
      }
    } catch (err) {
      this.errorHandler(err as Error, event);
    }
  }

  private async drain(state: AsyncSubscriberState): Promise<void> {
    while (state.queue.length > 0) {
      const event = state.queue.shift()!;
      try {
        const r = state.cb(event);
        if (r instanceof Promise) await r;
        state.consecutiveErrors = 0;
        if (state.highWaterLogged && state.queue.length <= Math.floor(state.queueWarnThreshold / 2)) {
          // Re-arm the high-water log once the queue drains below half-threshold.
          state.highWaterLogged = false;
        }
      } catch (err) {
        state.consecutiveErrors += 1;
        this.errorHandler(err as Error, event);
        if (state.consecutiveErrors >= state.maxConsecutiveErrors) {
          // Dead-letter the event and reset so the subscriber doesn't get
          // permanently stuck on one bad payload.
          this.publish({
            id: `dead-letter-${state.name}-${event.id}`,
            type: 'dead_letter',
            ts: event.ts,
            source: 'event-bus',
            payload: {
              subscriber: state.name,
              originalEventType: event.type,
              originalEventId: event.id,
              originalPayload: (event as DomainEvent<any>).payload,
              error: (err as Error).message,
              consecutiveErrors: state.consecutiveErrors,
            },
          });
          state.consecutiveErrors = 0;
        }
      }
    }
    state.draining = false;
  }

  public clear(): void {
    this.subscribers.clear();
    this.asyncSubscribers.clear();
    this.wildcardSubscribers.clear();
  }
}

// Singleton instance for the core trading runtime (though DI is preferred where possible)
export const defaultEventBus = new EventBus();
