// ExecutionContext binds builtin series (open/high/low/close/volume/hl2/hlc3/ohlc4),
// holds user-assigned series, owns the per-bar quota counters, and collects emitted
// outputs (plots/shapes/hlines/bgcolors).

import { Series, DEFAULT_SERIES_CAPACITY } from './series.js';
import { QuotaError, RuntimeError } from './errors.js';

const BUILTIN_SERIES_NAMES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'];

// Timeframe → millisecond duration. Used by security() to detect a closed higher-TF bar.
const TF_DURATION_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
};

export function tfDurationMs(tf) {
  return TF_DURATION_MS[tf] || 0;
}

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

    // Indicator/strategy metadata (name + opts + kind).
    meta: { name: null, opts: {}, kind: 'indicator' },

    // Strategy state. Populated only when meta.kind === 'strategy'.
    strategy: null,

    // Emitted outputs accumulated during full-history run.
    outputs: new Map(), // outputName → { kind, opts, values, times }

    // Per-bar emitted markers/hlines/bgcolors during a single bar execution.
    barEmissions: [],

    // Time vector for the current run (host fills before iterating bars). Times are
    // stored in UNIX seconds (matching the lightweight-charts time axis convention).
    times: null,

    // Active bar index — set by the host before each runBar().
    barIndex: -1,

    // Higher-timeframe data for security() lookups. Map<tf, { times: number[] (sec),
    // open/high/low/close/volume: Float64Array, hl2/hlc3/ohlc4: Float64Array }>.
    htfData: new Map(),

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

    // Pre-build sorted, deduped HTF series arrays (one entry per higher-TF bar) for
    // each timeframe in `byTf`. Host supplies plain candle arrays the same shape as
    // ChartManager.candleMap: { openTime, open, high, low, close, volume }.
    loadHtfData(byTf) {
      this.htfData.clear();
      if (!byTf || typeof byTf !== 'object') return;
      for (const [tf, candles] of Object.entries(byTf)) {
        if (!Array.isArray(candles) || candles.length === 0) continue;
        // Sort & dedupe by openTime (host should pass clean data but be defensive).
        const sorted = candles
          .filter((c) => c && Number.isFinite(c.openTime))
          .slice()
          .sort((a, b) => a.openTime - b.openTime);
        const dedup = [];
        let lastOt = -1;
        for (const c of sorted) {
          if (c.openTime === lastOt) {
            dedup[dedup.length - 1] = c;
          } else {
            dedup.push(c);
            lastOt = c.openTime;
          }
        }
        const n = dedup.length;
        const times = new Float64Array(n);
        const opens = new Float64Array(n);
        const highs = new Float64Array(n);
        const lows = new Float64Array(n);
        const closes = new Float64Array(n);
        const volumes = new Float64Array(n);
        const hl2 = new Float64Array(n);
        const hlc3 = new Float64Array(n);
        const ohlc4 = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const c = dedup[i];
          times[i] = c.openTime;
          opens[i] = c.open;
          highs[i] = c.high;
          lows[i] = c.low;
          closes[i] = c.close;
          volumes[i] = c.volume;
          hl2[i] = (c.high + c.low) / 2;
          hlc3[i] = (c.high + c.low + c.close) / 3;
          ohlc4[i] = (c.open + c.high + c.low + c.close) / 4;
        }
        this.htfData.set(tf, {
          openTimes: times,
          open: opens,
          high: highs,
          low: lows,
          close: closes,
          volume: volumes,
          hl2,
          hlc3,
          ohlc4,
        });
      }
    },

    // Find the most recently CLOSED higher-TF bar at or before the current lower-TF
    // bar's open-time. Pine's no-lookahead semantic: returns the previous bar's source
    // value while the higher-TF candle covering current time is still forming.
    // Returns NaN if no closed bar is available yet.
    lookupHtfValue(tf, srcName) {
      const data = this.htfData.get(tf);
      if (!data) return NaN;
      const arr = data[srcName];
      if (!arr) return NaN;
      const currentTimeSec = this.times ? this.times[this.barIndex] : null;
      if (!Number.isFinite(currentTimeSec)) return NaN;
      const currentTimeMs = currentTimeSec * 1000;
      const durMs = tfDurationMs(tf);
      if (durMs <= 0) return NaN;
      // Binary search for the largest openTime H with H + durMs <= currentTimeMs.
      const ot = data.openTimes;
      let lo = 0;
      let hi = ot.length - 1;
      let foundIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ot[mid] + durMs <= currentTimeMs) {
          foundIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (foundIdx < 0) return NaN;
      return arr[foundIdx];
    },

    initStrategy(opts) {
      const initialCapital = Number(opts?.initial_capital);
      this.strategy = {
        initialCapital: Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : 10_000,
        position: null, // { side: 'long'|'short', entryPrice, entryBar, qty }
        trades: [], // closed trades, in order
        equity: [], // per-bar equity (initial + realized + unrealized) — one entry per bar
        equityTimes: [], // matching time vector
        markersBar: [], // pending markers to attach this bar (cleared at end of bar)
        markersAll: [], // all entry/exit markers (for snapshotOutputs)
      };
    },

    // Called by entry() / exit() builtins during runBar.
    strategyOrder(side, condition, opts) {
      if (this.meta.kind !== 'strategy' || !this.strategy) {
        throw new RuntimeError(
          'entry()/exit() may only be called from a strategy(...) script',
          { barIndex: this.barIndex },
        );
      }
      if (!condition) return;
      const close = this.builtins.close.get(0);
      if (!Number.isFinite(close)) return;
      const s = this.strategy;
      const t = this.times ? this.times[this.barIndex] : null;
      if (side === 'flat') {
        if (!s.position) return;
        this._closePosition(close, t, opts);
        return;
      }
      // side is 'long' or 'short'; auto-reverse if a contrary position is open.
      if (s.position && s.position.side !== side) {
        this._closePosition(close, t, { reason: 'reverse' });
      }
      if (s.position && s.position.side === side) return; // no pyramiding
      const qty = Math.max(0, Number(opts?.qty) || 1);
      s.position = { side, entryPrice: close, entryBar: this.barIndex, qty };
      s.markersBar.push({
        time: t,
        position: side === 'long' ? 'belowBar' : 'aboveBar',
        color: side === 'long' ? '#26a69a' : '#ef5350',
        shape: side === 'long' ? 'arrowUp' : 'arrowDown',
        text: side === 'long' ? 'L' : 'S',
      });
    },

    _closePosition(price, time, opts) {
      const s = this.strategy;
      if (!s.position) return;
      const pnl =
        s.position.side === 'long'
          ? (price - s.position.entryPrice) * s.position.qty
          : (s.position.entryPrice - price) * s.position.qty;
      const ret = s.position.entryPrice === 0 ? 0 : pnl / (s.position.entryPrice * s.position.qty);
      s.trades.push({
        side: s.position.side,
        entryPrice: s.position.entryPrice,
        exitPrice: price,
        entryBar: s.position.entryBar,
        exitBar: this.barIndex,
        qty: s.position.qty,
        pnl,
        ret,
        reason: opts?.reason || 'exit',
      });
      s.markersBar.push({
        time,
        position: 'aboveBar',
        color: pnl >= 0 ? '#9ccc65' : '#ef5350',
        shape: 'circle',
        text: pnl >= 0 ? 'X+' : 'X-',
      });
      s.position = null;
    },

    // Called once per bar after the script statements run.
    tickStrategyBar() {
      const s = this.strategy;
      if (!s) return;
      const close = this.builtins.close.get(0);
      // Equity = initial + realized PnL + unrealized PnL of open position.
      let realized = 0;
      for (const t of s.trades) realized += t.pnl;
      let unrealized = 0;
      if (s.position && Number.isFinite(close)) {
        unrealized =
          s.position.side === 'long'
            ? (close - s.position.entryPrice) * s.position.qty
            : (s.position.entryPrice - close) * s.position.qty;
      }
      const t = this.times ? this.times[this.barIndex] : null;
      s.equity.push(s.initialCapital + realized + unrealized);
      s.equityTimes.push(t);
      // Flush bar markers.
      if (s.markersBar.length) {
        for (const m of s.markersBar) s.markersAll.push(m);
        s.markersBar = [];
      }
    },

    strategyStats() {
      const s = this.strategy;
      if (!s) return null;
      const trades = s.trades.length;
      let wins = 0;
      let losses = 0;
      let winSum = 0;
      let lossSum = 0;
      for (const t of s.trades) {
        if (t.pnl > 0) {
          wins += 1;
          winSum += t.pnl;
        } else if (t.pnl < 0) {
          losses += 1;
          lossSum += t.pnl;
        }
      }
      const totalPnl = winSum + lossSum;
      const finalEquity = s.equity.length ? s.equity[s.equity.length - 1] : s.initialCapital;
      const totalReturn = (finalEquity - s.initialCapital) / s.initialCapital;
      let peak = s.initialCapital;
      let maxDD = 0;
      for (const eq of s.equity) {
        if (eq > peak) peak = eq;
        const dd = peak > 0 ? (peak - eq) / peak : 0;
        if (dd > maxDD) maxDD = dd;
      }
      const openPos = s.position
        ? {
            side: s.position.side,
            entryPrice: s.position.entryPrice,
            entryBar: s.position.entryBar,
            qty: s.position.qty,
          }
        : null;
      return {
        initialCapital: s.initialCapital,
        finalEquity,
        totalPnl,
        totalReturn,
        trades,
        wins,
        losses,
        winRate: trades > 0 ? wins / trades : 0,
        avgWin: wins > 0 ? winSum / wins : 0,
        avgLoss: losses > 0 ? lossSum / losses : 0,
        maxDrawdown: maxDD,
        openPosition: openPos,
      };
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
      if (this.meta.kind === 'strategy' && this.strategy) {
        // Equity curve as a line in pane 1 (sub-pane).
        const eqData = this.strategy.equity.map((v, i) => ({
          time: this.strategy.equityTimes[i],
          value: v,
        }));
        out.push({
          name: '__strategy_equity',
          kind: 'line',
          opts: { color: '#42a5f5', lineWidth: 1.5, pane: 1, title: 'Equity' },
          data: eqData,
        });
        out.push({
          name: '__strategy_markers',
          kind: 'marker',
          opts: {},
          markers: this.strategy.markersAll,
        });
        out.push({
          name: '__strategy_stats',
          kind: 'stats',
          opts: {},
          stats: this.strategyStats(),
          trades: this.strategy.trades,
        });
      }
      return out;
    },

    // Per-bar delta after the host has called runBar(): which outputs gained a new sample,
    // which markers were added. Used for live-bar updates.
    snapshotDelta(prevSnapshot) {
      const deltas = [];
      const t = this.times ? this.times[this.barIndex] : null;
      if (this.meta.kind === 'strategy' && this.strategy) {
        const lastEq = this.strategy.equity[this.strategy.equity.length - 1];
        if (Number.isFinite(lastEq)) {
          deltas.push({ name: '__strategy_equity', kind: 'line', point: { time: t, value: lastEq } });
        }
        const prevMarkers = prevSnapshot?.get('__strategy_markers')?.markers ?? 0;
        const totalMarkers = this.strategy.markersAll.length;
        if (totalMarkers > prevMarkers) {
          deltas.push({
            name: '__strategy_markers',
            kind: 'marker',
            markers: this.strategy.markersAll.slice(prevMarkers),
          });
        }
        deltas.push({
          name: '__strategy_stats',
          kind: 'stats',
          stats: this.strategyStats(),
          trades: this.strategy.trades,
        });
      }
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
      if (this.meta.kind === 'strategy' && this.strategy) {
        m.set('__strategy_markers', { markers: this.strategy.markersAll.length });
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
