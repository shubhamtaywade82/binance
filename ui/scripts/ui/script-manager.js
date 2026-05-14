// Main-thread orchestrator: owns the worker, the overlay manager, and the script store.
// Drives compile/run on apply, dispatches live bars, and re-runs on TF / symbol change.

import { MSG } from '../worker/protocol.js';
import { ChartOverlayManager } from './script-overlay.js';
import { SAMPLE_SCRIPT, makeId, pickAdapter } from './script-store.js';
import { tokenize, parse } from '@coindcx/indicator-runtime';
import { generateStrategyTs } from './ts-export.js';

export class ScriptManager extends EventTarget {
  constructor(chartManager, opts = {}) {
    super();
    this.chartManager = chartManager;
    this.overlay = new ChartOverlayManager(chartManager);
    if (opts.store) {
      this.store = opts.store;
    } else {
      const remote =
        opts.remote === true ||
        (typeof import.meta !== 'undefined' &&
          import.meta.env &&
          (import.meta.env.VITE_NANOPINE_REMOTE === 'true' ||
            import.meta.env.VITE_NANOPINE_REMOTE === '1'));
      this.store = pickAdapter({
        remote,
        onChange: (remoteScripts) => {
          this.scripts = remoteScripts;
          this.dispatchEvent(new CustomEvent('change'));
          this.applyAllEnabled();
        },
      });
    }

    /** @type {Array<{id:string,name:string,source:string,inputs:object,enabled:boolean,createdAt:number,updatedAt:number}>} */
    this.scripts = this.store.list();
    /** Active per-script status: { state: 'idle'|'running'|'error', error?: object, meta?: object } */
    this.status = new Map();
    /** @type {string|null} active timeframe */
    this.activeTf = chartManager?.currentTf || null;
    /** Rolling alert log (newest first) capped at 200 entries. */
    this.alerts = [];
    /** Latest strategy stats per instanceId. */
    this.stats = new Map();
    this._notificationsRequested = false;

    this.worker = null;
    this._workerErrorBackoff = 0;
    this._initWorker();
    this.overlay.onAlert((ev) => this._onAlert(ev));
  }

  ingestServerAlert(msg) {
    if (!msg || typeof msg.message !== 'string') return;
    const entry = {
      id: `srv_${msg.scriptId || 'unknown'}_${this.alerts.length}_${Date.now()}`,
      instanceId: msg.scriptId,
      scriptName: msg.scriptName || 'Server',
      message: msg.message,
      time: msg.time,
      bar: msg.bar,
      at: Date.now(),
      serverSide: true,
    };
    this.alerts.unshift(entry);
    if (this.alerts.length > 200) this.alerts.length = 200;
    this.dispatchEvent(new CustomEvent('alert', { detail: entry }));
    this._maybeNotify(entry);
  }

  _setStats(instanceId, out) {
    this.stats.set(instanceId, {
      stats: out.stats || null,
      trades: out.trades || [],
      updatedAt: Date.now(),
    });
    this.dispatchEvent(new CustomEvent('stats', { detail: { id: instanceId } }));
  }

  getStats(id) {
    return this.stats.get(id) || null;
  }

  _onAlert(ev) {
    const sc = this.scripts.find((s) => s.id === ev.instanceId);
    const scriptName = sc?.name || 'Script';
    const entry = {
      id: `${ev.instanceId}_${this.alerts.length}_${Date.now()}`,
      instanceId: ev.instanceId,
      scriptName,
      message: ev.message,
      time: ev.time,
      bar: ev.bar,
      at: Date.now(),
    };
    this.alerts.unshift(entry);
    if (this.alerts.length > 200) this.alerts.length = 200;
    this.dispatchEvent(new CustomEvent('alert', { detail: entry }));
    this._maybeNotify(entry);
  }

  _maybeNotify(entry) {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission === 'granted') {
      try {
        const n = new Notification(entry.scriptName, { body: entry.message });
        setTimeout(() => n.close(), 5000);
      } catch {
        /* ignore */
      }
      return;
    }
    if (Notification.permission === 'default' && !this._notificationsRequested) {
      this._notificationsRequested = true;
      try {
        Notification.requestPermission().catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  _initWorker() {
    if (typeof Worker === 'undefined') {
      // Non-browser environment (e.g. unit tests). Skip silently — the data-management
      // surface (create/update/import/export) still works.
      this.worker = null;
      return;
    }
    try {
      this.worker = new Worker(new URL('../worker/script-worker.js', import.meta.url), {
        type: 'module',
      });
      this.worker.addEventListener('message', (ev) => this._onWorkerMessage(ev));
      this.worker.addEventListener('error', (ev) => {
        console.error('[nanopine] worker error', ev.message, ev.filename, ev.lineno);
      });
    } catch (err) {
      console.error('[nanopine] worker init failed', err);
      this.worker = null;
    }
  }

  _onWorkerMessage(ev) {
    const msg = ev.data;
    if (!msg || !msg.kind) return;
    switch (msg.kind) {
      case MSG.COMPILED: {
        const { chartOutputs, statsOutput } = splitStats(msg.outputs);
        this.overlay.apply(msg.instanceId, chartOutputs);
        if (statsOutput) this._setStats(msg.instanceId, statsOutput);
        this.status.set(msg.instanceId, { state: 'running', meta: msg.meta });
        this.dispatchEvent(new CustomEvent('status', { detail: { id: msg.instanceId } }));
        break;
      }
      case MSG.TICK: {
        const { chartDeltas, statsDelta } = splitStatsDelta(msg.deltas);
        this.overlay.update(msg.instanceId, chartDeltas);
        if (statsDelta) this._setStats(msg.instanceId, statsDelta);
        if (msg.warning) console.warn('[nanopine]', msg.instanceId, msg.warning);
        break;
      }
      case MSG.SWEEP_RESULT: {
        const pending = this._sweepPromises?.get(msg.sweepId);
        if (pending) {
          this._sweepPromises.delete(msg.sweepId);
          pending.resolve(msg.results || []);
        }
        break;
      }
      case MSG.ERROR: {
        this.overlay.remove(msg.instanceId);
        this.stats.delete(msg.instanceId);
        this.status.set(msg.instanceId, { state: 'error', error: msg.error });
        // Disable the script so it doesn't auto-run again on next snapshot.
        const sc = this.scripts.find((s) => s.id === msg.instanceId);
        if (sc) {
          sc.enabled = false;
          this.store.saveAll(this.scripts);
        }
        this.dispatchEvent(
          new CustomEvent('status', { detail: { id: msg.instanceId, error: msg.error } }),
        );
        break;
      }
      default:
        break;
    }
  }

  // ---- script management -----------------------------------------------------

  list() {
    return this.scripts.slice();
  }

  getStatus(id) {
    return this.status.get(id) || { state: 'idle' };
  }

  create({ name, source, inputs }) {
    const now = Date.now();
    const sc = {
      id: makeId(),
      name: name || `Script ${this.scripts.length + 1}`,
      source: source || SAMPLE_SCRIPT,
      inputs: inputs || {},
      enabled: false,
      createdAt: now,
      updatedAt: now,
    };
    this.scripts.push(sc);
    this.store.saveAll(this.scripts);
    this.dispatchEvent(new CustomEvent('change'));
    return sc;
  }

  update(id, patch) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) return null;
    Object.assign(sc, patch, { updatedAt: Date.now() });
    this.store.saveAll(this.scripts);
    if (sc.enabled) this.apply(id);
    this.dispatchEvent(new CustomEvent('change'));
    return sc;
  }

  exportAll() {
    return {
      version: 1,
      exportedAt: Date.now(),
      scripts: this.scripts.map((s) => ({
        name: s.name,
        source: s.source,
        inputs: s.inputs || {},
        enabled: false,
      })),
    };
  }

  importMany(payload, { replace = false } = {}) {
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.scripts) ? payload.scripts : null;
    if (!list) throw new Error('Invalid import payload — expected an array or { scripts: [] }');
    const now = Date.now();
    const incoming = list
      .filter((s) => s && typeof s.source === 'string')
      .map((s) => ({
        id: makeId(),
        name: typeof s.name === 'string' && s.name ? s.name : 'Imported script',
        source: s.source,
        inputs: s.inputs && typeof s.inputs === 'object' ? { ...s.inputs } : {},
        enabled: false,
        createdAt: now,
        updatedAt: now,
      }));
    if (replace) this.scripts = incoming;
    else this.scripts.push(...incoming);
    this.store.saveAll(this.scripts);
    this.dispatchEvent(new CustomEvent('change'));
    return incoming;
  }

  exportAsTypescript(id) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) throw new Error('Script not found');
    const program = parse(tokenize(sc.source));
    return generateStrategyTs(sc, program);
  }

  collectSweepRanges(id) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) throw new Error('Script not found');
    const program = parse(tokenize(sc.source));
    const ranges = [];
    for (const stmt of program.body) {
      if (stmt.type !== 'InputDecl') continue;
      if (stmt.kind !== 'int' && stmt.kind !== 'float') continue;
      const def = stmt.args[0];
      if (!def || (def.type !== 'Number')) continue;
      ranges.push({ name: stmt.name, kind: stmt.kind, default: def.value });
    }
    return ranges;
  }

  async runSweep(id, ranges) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) throw new Error('Script not found');
    if (!this.worker) throw new Error('Worker unavailable');
    const tf = this.chartManager?.currentTf;
    const candles = tf ? this.chartManager?.candleMap?.[tf] : null;
    if (!candles || !candles.length) throw new Error('No candles loaded — open the chart first');
    const combinations = expandCombinations(ranges);
    if (!combinations.length) throw new Error('Range expansion produced zero combinations');
    if (combinations.length > 1000) {
      throw new Error(
        `Sweep would run ${combinations.length} combinations (cap is 1000). Tighten your ranges.`,
      );
    }
    this._sweepPromises = this._sweepPromises || new Map();
    const sweepId = `sw_${Math.random().toString(36).slice(2, 10)}`;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._sweepPromises.delete(sweepId);
        reject(new Error('Sweep timed out after 60 s'));
      }, 60_000);
      this._sweepPromises.set(sweepId, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      this.worker.postMessage({
        kind: MSG.SWEEP,
        sweepId,
        source: sc.source,
        candles: candles.map(toPlainCandle),
        extraCandles: this._collectExtraCandles(tf),
        combinations,
      });
    });
    // Sort by total PnL desc, NaNs / errors last.
    result.sort((a, b) => {
      const pa = a.stats?.totalPnl ?? -Infinity;
      const pb = b.stats?.totalPnl ?? -Infinity;
      return pb - pa;
    });
    return result;
  }

  duplicate(id) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) return null;
    return this.create({
      name: `${sc.name} (copy)`,
      source: sc.source,
      inputs: { ...sc.inputs },
    });
  }

  delete(id) {
    const idx = this.scripts.findIndex((s) => s.id === id);
    if (idx < 0) return;
    this.overlay.remove(id);
    this.worker?.postMessage({ kind: MSG.REMOVE, instanceId: id });
    this.scripts.splice(idx, 1);
    this.status.delete(id);
    this.store.saveAll(this.scripts);
    this.dispatchEvent(new CustomEvent('change'));
  }

  setServerSide(id, on) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) return;
    sc.runServerSide = !!on;
    sc.updatedAt = Date.now();
    this.store.saveAll(this.scripts);
    this.dispatchEvent(new CustomEvent('change'));
  }

  setEnabled(id, on) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) return;
    sc.enabled = !!on;
    sc.updatedAt = Date.now();
    this.store.saveAll(this.scripts);
    if (sc.enabled) this.apply(id);
    else {
      this.overlay.remove(id);
      this.worker?.postMessage({ kind: MSG.REMOVE, instanceId: id });
      this.status.delete(id);
    }
    this.dispatchEvent(new CustomEvent('change'));
  }

  // ---- compilation & live data ----------------------------------------------

  apply(id) {
    const sc = this.scripts.find((s) => s.id === id);
    if (!sc) return;
    const tf = this.chartManager?.currentTf;
    const candles = tf ? this.chartManager?.candleMap?.[tf] : null;
    if (!this.worker) return;
    if (!candles || candles.length === 0) {
      // Defer until the first snapshot lands.
      return;
    }
    this.activeTf = tf;
    this.overlay.remove(id);
    this.worker.postMessage({
      kind: MSG.COMPILE_RUN,
      instanceId: id,
      source: sc.source,
      inputs: sc.inputs,
      candles: candles.map(toPlainCandle),
      extraCandles: this._collectExtraCandles(tf),
    });
  }

  _collectExtraCandles(activeTf) {
    const map = this.chartManager?.candleMap || {};
    const out = {};
    for (const [tf, arr] of Object.entries(map)) {
      if (tf === activeTf) continue;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      out[tf] = arr.map(toPlainCandle);
    }
    return out;
  }

  applyAllEnabled() {
    for (const sc of this.scripts) if (sc.enabled) this.apply(sc.id);
  }

  onSnapshot() {
    // Snapshot already populated chartManager.candleMap before this is called.
    this.applyAllEnabled();
  }

  onTfChange(tf) {
    this.activeTf = tf;
    this.applyAllEnabled();
  }

  onClosedBar(tf, candle) {
    if (tf !== this.activeTf) return;
    if (!this.worker) return;
    const payload = toPlainCandle(candle);
    for (const sc of this.scripts) {
      if (!sc.enabled) continue;
      if (this.status.get(sc.id)?.state !== 'running') continue;
      this.worker.postMessage({ kind: MSG.BAR, instanceId: sc.id, candle: payload });
    }
  }
}

function splitStats(outputs) {
  const chartOutputs = [];
  let statsOutput = null;
  for (const o of outputs || []) {
    if (o.kind === 'stats') statsOutput = o;
    else chartOutputs.push(o);
  }
  return { chartOutputs, statsOutput };
}

function splitStatsDelta(deltas) {
  const chartDeltas = [];
  let statsDelta = null;
  for (const d of deltas || []) {
    if (d.kind === 'stats') statsDelta = d;
    else chartDeltas.push(d);
  }
  return { chartDeltas, statsDelta };
}

function expandCombinations(ranges) {
  if (!ranges.length) return [];
  const axes = ranges.map((r) => {
    const values = [];
    const start = Number(r.start);
    const end = Number(r.end);
    let step = Number(r.step);
    if (!Number.isFinite(step) || step === 0) step = 1;
    if (start <= end) {
      if (step < 0) step = -step;
      for (let v = start; v <= end + 1e-9; v += step) {
        values.push(r.kind === 'int' ? Math.round(v) : v);
      }
    } else {
      if (step > 0) step = -step;
      for (let v = start; v >= end - 1e-9; v += step) {
        values.push(r.kind === 'int' ? Math.round(v) : v);
      }
    }
    return { name: r.name, values };
  });
  const out = [];
  const idx = axes.map(() => 0);
  while (true) {
    const combo = {};
    for (let i = 0; i < axes.length; i++) combo[axes[i].name] = axes[i].values[idx[i]];
    out.push(combo);
    let i = axes.length - 1;
    while (i >= 0) {
      idx[i] += 1;
      if (idx[i] < axes[i].values.length) break;
      idx[i] = 0;
      i -= 1;
    }
    if (i < 0) break;
  }
  return out;
}

function toPlainCandle(c) {
  if (!c) return null;
  return {
    openTime: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  };
}
