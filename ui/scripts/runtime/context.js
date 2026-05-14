// ExecutionContext binds builtin series (open/high/low/close/volume/hl2/hlc3/ohlc4),
// holds user-assigned series, owns the per-bar quota counters, and collects emitted
// outputs (plots/shapes/hlines/bgcolors).

import { Series, DEFAULT_SERIES_CAPACITY } from './series.js';
import { QuotaError } from './errors.js';

const BUILTIN_SERIES_NAMES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];

const DEFAULTS = {
  nodeBudgetPerBar: 10_000,
  liveBarBudgetMs: 5,
  fullHistoryBudgetMs: 250,
  seriesCapacity: DEFAULT_SERIES_CAPACITY,
};

export function createContext(opts = {}) {
  const capacity = opts.seriesCapacity || DEFAULTS.seriesCapacity;
  const builtins = Object.fromEntries(
    BUILTIN_SERIES_NAMES.map((name) => [name, new Series(capacity)]),
  );

  return {
    capacity,
    nodeBudgetPerBar: opts.nodeBudgetPerBar || DEFAULTS.nodeBudgetPerBar,
    liveBarBudgetMs: opts.liveBarBudgetMs || DEFAULTS.liveBarBudgetMs,
    fullHistoryBudgetMs: opts.fullHistoryBudgetMs || DEFAULTS.fullHistoryBudgetMs,

    // Built-in price/volume series — host pushes one value per bar before runBar().
    builtins,

    // User-assigned named series (each binding becomes its own Series so `e9[1]` works).
    userSeries: new Map(),

    // Inputs declared by the script and overridden via instance inputs.
    inputs: new Map(),

    // Per-call-site stateful TA caches — keyed by Call AST node identity.
    callState: new WeakMap(),

    // Quota counters.
    nodeBudgetRemaining: 0,

    // Indicator metadata (name + opts).
    meta: { name: null, opts: {} },

    // Emitted outputs accumulated during full-history run.
    outputs: new Map(), // outputName → { kind, opts, values, times }

    // Per-bar emitted markers/hlines/bgcolors during a single bar execution.
    barEmissions: [],

    // Time vector for the current run (host fills before iterating bars).
    times: null,

    // Active bar index — set by the host before each runBar().
    barIndex: -1,

    resetForBar(barIndex) {
      this.barIndex = barIndex;
      this.nodeBudgetRemaining = this.nodeBudgetPerBar;
      this.barEmissions = [];
    },

    tickNodeBudget() {
      this.nodeBudgetRemaining -= 1;
      if (this.nodeBudgetRemaining < 0) {
        throw new QuotaError(
          `Per-bar AST node budget exhausted (${this.nodeBudgetPerBar})`,
          { barIndex: this.barIndex },
        );
      }
    },

    pushBar(candle) {
      const { open, high, low, close, volume } = candle;
      this.builtins.open.push(open);
      this.builtins.high.push(high);
      this.builtins.low.push(low);
      this.builtins.close.push(close);
      this.builtins.volume.push(volume);
      this.builtins.hl2.push((high + low) / 2);
      this.builtins.hlc3.push((high + low + close) / 3);
      this.builtins.ohlc4.push((open + high + low + close) / 4);
    },

    // Lookup a name during interpretation. Returns either a Series (built-in or user)
    // or a primitive (number/string/bool) from inputs. Throws if unknown.
    resolve(name) {
      if (name in this.builtins) return this.builtins[name];
      if (this.userSeries.has(name)) return this.userSeries.get(name);
      if (this.inputs.has(name)) return this.inputs.get(name);
      return undefined;
    },

    assign(name, value) {
      // Promote any assigned numeric/scalar binding into a Series so `name[k]` works.
      let s = this.userSeries.get(name);
      if (!s) {
        s = new Series(this.capacity);
        this.userSeries.set(name, s);
      }
      const num =
        typeof value === 'number'
          ? value
          : value === true
            ? 1
            : value === false
              ? 0
              : value instanceof Series
                ? value.get(0)
                : NaN;
      s.push(num);
      // Also expose the raw value of the latest bar through the same Series via get(0).
      return s;
    },

    setInput(name, value) {
      this.inputs.set(name, value);
    },

    emitPlot(node, kind, value, opts) {
      const outName = opts.title || `plot_${nodeKey(node)}`;
      let out = this.outputs.get(outName);
      if (!out) {
        out = {
          name: outName,
          kind,
          opts: { ...opts },
          values: [],
          times: [],
        };
        this.outputs.set(outName, out);
      } else {
        // The kind for a given output name is decided on first emission and pinned —
        // changing it mid-script would invalidate the existing series handle on the
        // main thread. Honour last-write-wins for styling only.
        if (!sameOpts(out.opts, opts)) {
          out.opts = { ...out.opts, ...opts };
        }
      }
      const t = this.times ? this.times[this.barIndex] : null;
      out.values.push(value);
      out.times.push(t);
    },

    emitAlert(node, message, opts) {
      const outName = `alert_${nodeKey(node)}`;
      let out = this.outputs.get(outName);
      if (!out) {
        out = { name: outName, kind: 'alert', opts: { ...opts }, events: [] };
        this.outputs.set(outName, out);
      }
      const t = this.times ? this.times[this.barIndex] : null;
      out.events.push({ time: t, message, bar: this.barIndex });
    },

    emitShape(node, cond, opts) {
      if (!cond) return;
      const outName = opts.title || `shape_${nodeKey(node)}`;
      let out = this.outputs.get(outName);
      if (!out) {
        out = { name: outName, kind: 'marker', opts: { ...opts }, markers: [] };
        this.outputs.set(outName, out);
      }
      const t = this.times ? this.times[this.barIndex] : null;
      out.markers.push({ time: t, ...opts });
    },

    emitHLine(node, price, opts) {
      const outName = opts.title || `hline_${nodeKey(node)}`;
      // Last-write-wins so the price reflects the latest bar.
      this.outputs.set(outName, { name: outName, kind: 'hline', price, opts: { ...opts } });
    },

    emitBgColor(node, color, opts) {
      const outName = `bgcolor_${nodeKey(node)}`;
      let out = this.outputs.get(outName);
      if (!out) {
        out = { name: outName, kind: 'bgcolor', opts: { ...opts }, segments: [] };
        this.outputs.set(outName, out);
      }
      const t = this.times ? this.times[this.barIndex] : null;
      out.segments.push({ time: t, color, ...opts });
    },

    // Final output snapshot suitable for postMessage. Series-backed plots are returned
    // as plain arrays (Float64Array would also work but the renderer expects {time,value}).
    snapshotOutputs() {
      const out = [];
      for (const o of this.outputs.values()) {
        if (o.kind === 'line' || o.kind === 'histogram' || o.kind === 'area') {
          out.push({
            name: o.name,
            kind: o.kind,
            opts: o.opts,
            data: o.values.map((v, i) => ({ time: o.times[i], value: v })),
          });
        } else if (o.kind === 'marker') {
          out.push({ name: o.name, kind: 'marker', opts: o.opts, markers: o.markers });
        } else if (o.kind === 'hline') {
          out.push({ name: o.name, kind: 'hline', opts: o.opts, price: o.price });
        } else if (o.kind === 'bgcolor') {
          out.push({ name: o.name, kind: 'bgcolor', opts: o.opts, segments: o.segments });
        } else if (o.kind === 'alert') {
          out.push({ name: o.name, kind: 'alert', opts: o.opts, events: o.events });
        }
      }
      return out;
    },

    // Per-bar delta after the host has called runBar(): which outputs gained a new sample,
    // which markers were added. Used for live-bar updates.
    snapshotDelta(prevSnapshot) {
      const deltas = [];
      const t = this.times ? this.times[this.barIndex] : null;
      for (const o of this.outputs.values()) {
        if (o.kind === 'line' || o.kind === 'histogram' || o.kind === 'area') {
          const last = o.values[o.values.length - 1];
          deltas.push({ name: o.name, kind: o.kind, point: { time: t, value: last } });
        } else if (o.kind === 'marker') {
          const prev = prevSnapshot?.get(o.name)?.markers ?? 0;
          const next = o.markers.length;
          if (next > prev) {
            deltas.push({
              name: o.name,
              kind: 'marker',
              markers: o.markers.slice(prev),
            });
          }
        } else if (o.kind === 'hline') {
          deltas.push({ name: o.name, kind: 'hline', price: o.price });
        } else if (o.kind === 'bgcolor') {
          const lastSeg = o.segments[o.segments.length - 1];
          deltas.push({ name: o.name, kind: 'bgcolor', segment: lastSeg });
        } else if (o.kind === 'alert') {
          const prev = prevSnapshot?.get(o.name)?.events ?? 0;
          const next = o.events.length;
          if (next > prev) {
            deltas.push({
              name: o.name,
              kind: 'alert',
              events: o.events.slice(prev),
            });
          }
        }
      }
      return deltas;
    },

    snapshotCounts() {
      const m = new Map();
      for (const o of this.outputs.values()) {
        if (o.kind === 'marker') m.set(o.name, { markers: o.markers.length });
        else if (o.kind === 'alert') m.set(o.name, { events: o.events.length });
      }
      return m;
    },
  };
}

function nodeKey(node) {
  // Use line/col as a stable identity for a call site within a single AST.
  return `${node.line ?? 0}_${node.col ?? 0}`;
}

function sameOpts(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
