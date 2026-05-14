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

/**
 * Server-backed adapter — writes to /api/scripts and mirrors to localStorage so the
 * synchronous list() works during boot. On construction, kicks off a background hydrate
 * that replaces the local cache once the server responds. Subsequent saveAll() calls
 * write through to both localStorage (immediate) and the server (best-effort PUT).
 */
export class RemoteAdapter {
  constructor(opts = {}) {
    this.endpoint = (opts.endpoint || '/api/scripts').replace(/\/+$/, '');
    this._local = new LocalAdapter();
    this._onChange = opts.onChange || null;
    this._hydrating = false;
    this._lastPut = 0;
    this._putTimer = null;
    this._fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._hydrate();
  }

  list() {
    return this._local.list();
  }

  saveAll(scripts) {
    this._local.saveAll(scripts);
    this._schedulePut(scripts);
  }

  async _hydrate() {
    if (!this._fetchImpl) return;
    this._hydrating = true;
    try {
      const r = await this._fetchImpl(this.endpoint, { method: 'GET' });
      if (!r.ok) throw new Error(`GET ${this.endpoint} → ${r.status}`);
      const body = await r.json();
      const remote = Array.isArray(body?.scripts) ? body.scripts : [];
      if (remote.length) {
        this._local.saveAll(remote);
        if (this._onChange) this._onChange(remote);
      } else {
        // Empty server → push whatever's in localStorage so other devices see it.
        const local = this._local.list();
        if (local.length) await this._putAll(local);
      }
    } catch (e) {
      // Network / 5xx — keep the local cache. Silent: console.warn would spam the dev console.
      void e;
    } finally {
      this._hydrating = false;
    }
  }

  _schedulePut(scripts) {
    if (!this._fetchImpl || this._hydrating) return;
    // Debounce — multiple edits in quick succession collapse into one PUT.
    if (this._putTimer) clearTimeout(this._putTimer);
    this._putTimer = setTimeout(() => {
      this._putTimer = null;
      this._putAll(scripts).catch(() => {
        /* best-effort */
      });
    }, 400);
  }

  async _putAll(scripts) {
    if (!this._fetchImpl) return;
    await this._fetchImpl(this.endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scripts),
    });
    this._lastPut = Date.now();
  }
}

/**
 * Pick an adapter at boot. Defaults to LocalAdapter; passing a truthy {remote: true}
 * (typically driven by an env flag the host app reads from import.meta.env) switches
 * to the server-backed adapter.
 */
export function pickAdapter(opts = {}) {
  if (opts.remote) return new RemoteAdapter(opts);
  return new LocalAdapter();
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
