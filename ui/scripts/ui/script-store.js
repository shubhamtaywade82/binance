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

export const SAMPLE_STRATEGY = `strategy("EMA Cross Strategy", initial_capital=10000)
fastLen = input.int(9,  title="Fast")
slowLen = input.int(21, title="Slow")
fast = ema(close, fastLen)
slow = ema(close, slowLen)
plot(fast, color="lime",    title="Fast EMA")
plot(slow, color="magenta", title="Slow EMA")
buy  = crossover(fast,  slow)
sell = crossunder(fast, slow)
entry(buy,  "long")
entry(sell, "short")
`;

export const SAMPLE_RSI_OSC = `indicator("RSI sub-pane", overlay=false)
len = input.int(14, title="Length")
r = rsi(close, len)
plot(r, color="#42a5f5", title="RSI")
hline(70, color="#ef5350", title="Overbought")
hline(30, color="#26a69a", title="Oversold")
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
    {
      id: makeId(),
      name: 'EMA Cross Strategy (sample)',
      source: SAMPLE_STRATEGY,
      inputs: {},
      enabled: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: makeId(),
      name: 'RSI sub-pane (sample)',
      source: SAMPLE_RSI_OSC,
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
