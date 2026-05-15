import { describe, expect, it, beforeEach } from 'vitest';
// @ts-expect-error — JS module
import { ScriptManager } from '../../ui/scripts/ui/script-manager.js';

class InMemoryStore {
  data: any[] = [];
  list() {
    return this.data.slice();
  }
  saveAll(scripts: any[]) {
    this.data = scripts.slice();
  }
}

class FakeChartManager {
  candleMap: Record<string, unknown[]> = {};
  currentTf = '5m';
  chart = null;
  candleSeries = null;
}

const mgr = (store: InMemoryStore) => {
  // The worker construction inside the manager will fail in Node — that's OK because
  // we only exercise data plumbing here. The manager's constructor swallows worker init
  // errors and proceeds with worker = null.
  // Workers are not available outside browsers; this throws synchronously and the
  // manager catches it.
  return new (ScriptManager as any)(new FakeChartManager(), { store });
};

describe('ScriptManager export/import roundtrip', () => {
  let store: InMemoryStore;
  let manager: any;

  beforeEach(() => {
    store = new InMemoryStore();
    // Seed two scripts so list() returns them at construction.
    store.data = [
      {
        id: 's1',
        name: 'One',
        source: 'indicator("a")\nplot(close)',
        inputs: { foo: 1 },
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 's2',
        name: 'Two',
        source: 'indicator("b")\nplot(open)',
        inputs: {},
        enabled: false,
        createdAt: 2,
        updatedAt: 2,
      },
    ];
    manager = mgr(store);
  });

  it('exportAll produces a versioned payload with names and sources', () => {
    const payload = manager.exportAll();
    expect(payload.version).toBe(1);
    expect(payload.scripts).toHaveLength(2);
    expect(payload.scripts[0].name).toBe('One');
    expect(payload.scripts[0].source).toContain('plot(close)');
    // Exported scripts default to disabled so importing won't auto-run unrelated work.
    expect(payload.scripts.every((s: any) => s.enabled === false)).toBe(true);
  });

  it('importMany appends with fresh IDs', () => {
    const payload = manager.exportAll();
    const before = manager.list().length;
    const imported = manager.importMany(payload);
    expect(manager.list().length).toBe(before + payload.scripts.length);
    // Imported scripts get fresh IDs so duplicates don't collide.
    const ids = new Set(manager.list().map((s: any) => s.id));
    expect(ids.size).toBe(manager.list().length);
    // And the exported sources roundtrip.
    expect(imported[0].source).toContain('plot(close)');
    // Disabled by default after import.
    expect(imported.every((s: any) => s.enabled === false)).toBe(true);
  });

  it('importMany rejects malformed payloads', () => {
    expect(() => manager.importMany('not an array')).toThrow();
    expect(() => manager.importMany({ scripts: 'nope' })).toThrow();
    // But it tolerates entries missing names — they fall back to "Imported script".
    const r = manager.importMany([{ source: 'plot(close)' }]);
    expect(r[0].name).toBe('Imported script');
  });
});
