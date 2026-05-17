import { describe, it, expect } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { ReplayEngine } from '../src/replay/replay-engine';
import { MarketClock } from '../src/core/time/market-clock';
import type { DomainEvent } from '@coindcx/contracts';
import type { EventStore } from '../src/persistence/event-store';

class InMemoryStore {
  constructor(private events: DomainEvent[]) {}
  async fetchEvents(fromTs: number, toTs: number, types?: string[]): Promise<DomainEvent[]> {
    return this.events
      .filter((e) => e.ts >= fromTs && e.ts <= toTs && (!types || types.includes(e.type)))
      .sort((a, b) => a.ts - b.ts);
  }
}

describe('ReplayEngine determinism', () => {
  it('preserves event order + sets clock to event ts', async () => {
    const events: DomainEvent[] = [
      { id: 'a', type: 'x', ts: 1000, source: 's', payload: 1 },
      { id: 'b', type: 'x', ts: 1500, source: 's', payload: 2 },
      { id: 'c', type: 'x', ts: 2000, source: 's', payload: 3 },
    ];
    const bus = new EventBus();
    const clock = new MarketClock();
    const captured: Array<{ id: string; clockTs: number }> = [];
    bus.subscribe('x', (e) => captured.push({ id: e.id, clockTs: clock.now() }));

    const engine = new ReplayEngine(new InMemoryStore(events) as unknown as EventStore, bus, clock);
    const result = await engine.replay({ fromTs: 0, toTs: 9999, speedMultiplier: Infinity });

    expect(result.dispatched).toBe(3);
    expect(captured.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(captured.map((c) => c.clockTs)).toEqual([1000, 1500, 2000]);
    expect(clock.getMode()).toBe('live');
  });

  it('produces identical downstream sequence on repeat', async () => {
    const events: DomainEvent[] = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`, type: 'tick', ts: i * 10, source: 's', payload: i,
    }));
    const store = new InMemoryStore(events) as unknown as EventStore;

    const runOnce = async () => {
      const bus = new EventBus();
      const clock = new MarketClock();
      const out: number[] = [];
      bus.subscribe('tick', (e: any) => out.push(e.payload * 2 + clock.now()));
      await new ReplayEngine(store, bus, clock).replay({ fromTs: 0, toTs: 9999, speedMultiplier: Infinity });
      return out;
    };

    const a = await runOnce();
    const b = await runOnce();
    expect(a).toEqual(b);
  });
});
