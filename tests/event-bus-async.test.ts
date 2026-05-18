import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events/event-bus';
import type { DomainEvent } from '@coindcx/contracts';

const mkEvent = (type: string, i = 0): DomainEvent<{ i: number }> => ({
  id: `${type}-${i}`,
  type,
  ts: i,
  source: 'test',
  payload: { i },
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EventBus.subscribeAsync (C-4)', () => {
  it('runs callbacks on a microtask boundary, not inside publish()', async () => {
    const bus = new EventBus();
    let observed = false;
    bus.subscribeAsync('t', () => { observed = true; });
    bus.publish(mkEvent('t'));
    // Should NOT have run yet — async subscribers are deferred to setImmediate.
    expect(observed).toBe(false);
    await wait(20);
    expect(observed).toBe(true);
  });

  it('preserves FIFO ordering inside one subscriber under back-pressure', async () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribeAsync('t', async (e) => {
      // Force interleaving: yield to event loop on every other event.
      await wait(2);
      seen.push((e.payload as { i: number }).i);
    });
    for (let i = 0; i < 10; i++) bus.publish(mkEvent('t', i));
    // Flush.
    await wait(80);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('isolates subscribers — one slow consumer does not block another', async () => {
    const bus = new EventBus();
    const slow: number[] = [];
    const fast: number[] = [];
    bus.subscribeAsync('t', async (e) => { await wait(20); slow.push((e.payload as { i: number }).i); });
    bus.subscribeAsync('t', (e) => { fast.push((e.payload as { i: number }).i); });
    for (let i = 0; i < 5; i++) bus.publish(mkEvent('t', i));

    // The fast subscriber should be done well before the slow one.
    await wait(15);
    expect(fast).toEqual([0, 1, 2, 3, 4]);
    expect(slow.length).toBeLessThanOrEqual(1);
    await wait(120);
    expect(slow).toEqual([0, 1, 2, 3, 4]);
  });

  it('publishers do not block on async subscribers (publish() returns immediately)', async () => {
    const bus = new EventBus();
    bus.subscribeAsync('t', async () => { await wait(50); });
    const start = Date.now();
    bus.publish(mkEvent('t'));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(10);
    await wait(80);
  });

  it('publishes eventbus.async_queue_high_water once when threshold is crossed', async () => {
    const bus = new EventBus();
    const hw: any[] = [];
    bus.subscribe('eventbus.async_queue_high_water', (e) => hw.push(e));
    // Slow consumer + low threshold to force the high-water emission.
    bus.subscribeAsync('t', async () => { await wait(50); }, { queueWarnThreshold: 3, name: 'slow' });
    for (let i = 0; i < 10; i++) bus.publish(mkEvent('t', i));
    // High water is published synchronously inside publish() when the queue
    // first exceeds the threshold, so it's observable immediately.
    expect(hw).toHaveLength(1);
    expect(hw[0].payload.subscriber).toBe('slow');
    expect(hw[0].payload.queueDepth).toBeGreaterThan(3);
    await wait(700);
  });

  it('dead-letters an event after maxConsecutiveErrors failures and resumes processing', async () => {
    const bus = new EventBus();
    const dlq: any[] = [];
    const processed: number[] = [];
    bus.subscribe('dead_letter', (e) => dlq.push(e));

    let i = 0;
    bus.subscribeAsync('t', (e) => {
      i++;
      if (i <= 3) throw new Error(`bad-${(e.payload as { i: number }).i}`);
      processed.push((e.payload as { i: number }).i);
    }, { maxConsecutiveErrors: 3, name: 'flaky' });

    bus.publish(mkEvent('t', 0));
    bus.publish(mkEvent('t', 1));
    bus.publish(mkEvent('t', 2));
    bus.publish(mkEvent('t', 3));
    bus.publish(mkEvent('t', 4));

    await wait(50);

    // After 3 errors the offending event is dead-lettered; subscriber resumes
    // and processes the rest.
    expect(dlq).toHaveLength(1);
    expect(dlq[0].payload.subscriber).toBe('flaky');
    expect(dlq[0].payload.originalEventType).toBe('t');
    expect(processed).toEqual([3, 4]);
  });

  it('sync subscribe still fires synchronously inside publish()', () => {
    const bus = new EventBus();
    let observed = false;
    bus.subscribe('t', () => { observed = true; });
    bus.publish(mkEvent('t'));
    expect(observed).toBe(true);
  });

  it('clear() drops async subscriber state too', async () => {
    const bus = new EventBus();
    let count = 0;
    bus.subscribeAsync('t', () => { count++; });
    bus.publish(mkEvent('t'));
    bus.clear();
    await wait(20);
    // The pending one already-queued event will still run (it's in flight),
    // but no further events are accepted after clear().
    const after = count;
    bus.publish(mkEvent('t'));
    await wait(20);
    expect(count).toBe(after);
  });
});
