// Versioned localStorage adapter for NanoPine scripts.
// Schema:
//   nanopine:v1:scripts → Array<{ id, name, source, inputs, enabled, createdAt, updatedAt }>
//
// A RemoteAdapter shim is exposed so Phase-5 server-side storage can drop in
// without touching the manager.

const STORAGE_KEY = 'nanopine:v1:scripts';

export const SAMPLE_SCRIPT = `indicator("EMA Cross")
fastLen = input.int(9, title="Fast")
slowLen = input.int(21, title="Slow")
fast = ema(close, fastLen)
slow = ema(close, slowLen)
buy  = crossover(fast,  slow)
sell = crossunder(fast, slow)
plot(fast, color="lime",    title="Fast EMA")
plot(slow, color="magenta", title="Slow EMA")
plotshape(buy,  location="belowbar", color="lime",    shape="triangleup",   title="buy")
plotshape(sell, location="abovebar", color="magenta", shape="triangledown", title="sell")
`;

export class LocalAdapter {
  list() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seedDefaults();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return seedDefaults();
      return parsed;
    } catch {
      return seedDefaults();
    }
  }

  saveAll(scripts) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
    } catch {
      /* quota / sandbox — ignore */
    }
  }
}

export class RemoteAdapter {
  // Phase-5 placeholder. Same signatures as LocalAdapter.
  list() {
    return [];
  }

  saveAll(_scripts) {
    /* TODO: PUT /api/scripts */
  }
}

function seedDefaults() {
  const now = Date.now();
  return [
    {
      id: makeId(),
      name: 'EMA Cross (sample)',
      source: SAMPLE_SCRIPT,
      inputs: {},
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function makeId() {
  return `s_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}
