// Main-thread orchestrator: owns the worker, the overlay manager, and the script store.
// Drives compile/run on apply, dispatches live bars, and re-runs on TF / symbol change.

import { MSG } from '../worker/protocol.js';
import { ChartOverlayManager } from './script-overlay.js';
import { LocalAdapter, SAMPLE_SCRIPT, makeId } from './script-store.js';

export class ScriptManager extends EventTarget {
  constructor(chartManager, opts = {}) {
    super();
    this.chartManager = chartManager;
    this.overlay = new ChartOverlayManager(chartManager);
    this.store = opts.store || new LocalAdapter();

    /** @type {Array<{id:string,name:string,source:string,inputs:object,enabled:boolean,createdAt:number,updatedAt:number}>} */
    this.scripts = this.store.list();
    /** Active per-script status: { state: 'idle'|'running'|'error', error?: object, meta?: object } */
    this.status = new Map();
    /** @type {string|null} active timeframe */
    this.activeTf = chartManager?.currentTf || null;

    this.worker = null;
    this._workerErrorBackoff = 0;
    this._initWorker();
  }

  _initWorker() {
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
        this.overlay.apply(msg.instanceId, msg.outputs);
        this.status.set(msg.instanceId, { state: 'running', meta: msg.meta });
        this.dispatchEvent(new CustomEvent('status', { detail: { id: msg.instanceId } }));
        break;
      }
      case MSG.TICK: {
        this.overlay.update(msg.instanceId, msg.deltas);
        if (msg.warning) console.warn('[nanopine]', msg.instanceId, msg.warning);
        break;
      }
      case MSG.ERROR: {
        this.overlay.remove(msg.instanceId);
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
    });
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
