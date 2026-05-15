import { DomainEvent } from '@coindcx/contracts';

type EventCallback<T = any> = (event: DomainEvent<T>) => void | Promise<void>;

export interface Subscription {
  unsubscribe: () => void;
}

export class EventBus {
  private subscribers: Map<string, Set<EventCallback>> = new Map();
  private wildcardSubscribers: Set<EventCallback> = new Set();
  private errorHandler: (err: Error, event: DomainEvent) => void;

  constructor(errorHandler?: (err: Error, event: DomainEvent) => void) {
    this.errorHandler = errorHandler || ((err, event) => {
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

  public subscribeAll(callback: EventCallback): Subscription {
    this.wildcardSubscribers.add(callback);
    return {
      unsubscribe: () => {
        this.wildcardSubscribers.delete(callback);
      }
    };
  }

  public publish(event: DomainEvent): void {
    // Process wildcard subscribers
    for (const callback of this.wildcardSubscribers) {
      this.invokeCallback(callback, event);
    }

    // Process specific event type subscribers
    const subs = this.subscribers.get(event.type);
    if (subs) {
      for (const callback of subs) {
        this.invokeCallback(callback, event);
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

  public clear(): void {
    this.subscribers.clear();
    this.wildcardSubscribers.clear();
  }
}

// Singleton instance for the core trading runtime (though DI is preferred where possible)
export const defaultEventBus = new EventBus();
