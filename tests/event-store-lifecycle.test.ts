import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import { EventStore } from '../src/persistence/event-store';
import type { PgWriter } from '../src/persistence/pg-writer';

const mkEvent = (type: string) => ({
  id: `${type}-${Math.random()}`,
  type,
  ts: 0,
  source: 'test',
  payload: {},
});

const stubPg = (): { pg: PgWriter; appendCount: () => number } => {
  let n = 0;
  const pg = {
    appendEvent: vi.fn().mockImplementation(async () => { n++; }),
  } as unknown as PgWriter;
  return { pg, appendCount: () => n };
};

describe('EventStore lifecycle (M-16)', () => {
  it('appendEvent is called for persistable events after startRecording', async () => {
    const bus = new EventBus();
    const { pg, appendCount } = stubPg();
    const store = new EventStore(pg, bus);
    store.startRecording();

    bus.publish(mkEvent('execution.order.filled'));
    bus.publish(mkEvent('strategy.signal'));
    await new Promise((r) => setImmediate(r));
    expect(appendCount()).toBe(2);
  });

  it('stop() detaches the subscription — subsequent events are NOT appended', async () => {
    const bus = new EventBus();
    const { pg, appendCount } = stubPg();
    const store = new EventStore(pg, bus);
    store.startRecording();

    bus.publish(mkEvent('execution.order.filled'));
    await new Promise((r) => setImmediate(r));
    expect(appendCount()).toBe(1);

    store.stop();
    bus.publish(mkEvent('execution.order.filled'));
    bus.publish(mkEvent('strategy.signal'));
    await new Promise((r) => setImmediate(r));
    expect(appendCount()).toBe(1);
  });

  it('startRecording is idempotent — second call does NOT register a duplicate subscriber', async () => {
    const bus = new EventBus();
    const { pg, appendCount } = stubPg();
    const store = new EventStore(pg, bus);
    store.startRecording();
    store.startRecording();
    bus.publish(mkEvent('execution.order.filled'));
    await new Promise((r) => setImmediate(r));
    expect(appendCount()).toBe(1);
  });

  it('stop() is a no-op when never started', () => {
    const bus = new EventBus();
    const { pg } = stubPg();
    const store = new EventStore(pg, bus);
    expect(() => store.stop()).not.toThrow();
  });
});
