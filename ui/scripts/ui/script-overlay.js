// ChartOverlayManager — owns lightweight-charts series, markers, and price lines
// that are produced by user scripts. One overlay manager spans many script instances;
// instance teardown removes all series owned by that instance atomically.
//
// Supports two panes:
//   pane 0 → the existing main chart (price overlay).
//   pane 1 → a lazily-created stacked sub-chart below the main chart, time-scale-synced.
// All pane >= 1 currently routes to the same sub-pane; Phase 3 can split into N panes.

import { createChart } from 'lightweight-charts';
import { BgColorPrimitive } from './bgcolor-primitive.js';

const DEFAULT_COLORS = ['#26a69a', '#ef5350', '#ffb300', '#42a5f5', '#ab47bc', '#9ccc65', '#ec407a', '#26c6da'];
const SUB_PANE_HEIGHT_PX = 160;

export class ChartOverlayManager {
  constructor(chartManager) {
    this.chartManager = chartManager;
    /** @type {Map<string, OverlayBucket>} */
    this.overlays = new Map();
    /** Alert events delivered to the host (ScriptManager) on every apply / update. */
    this.alertListeners = new Set();
    this._colorIdx = 0;

    // Lazily-created sub-pane (single instance for now — pane 1).
    this._subPane = null; // { container, chart, resizeObs, syncing, anchor }
    this._subPaneRefCount = 0;
    this._timeScaleSyncBound = false;

    // Lazily-attached background-color primitive on the price pane.
    this._bgPrimitive = null;
    this._bgSegmentsByInstance = new Map();
  }

  onAlert(fn) {
    this.alertListeners.add(fn);
    return () => this.alertListeners.delete(fn);
  }

  _autoColor() {
    const c = DEFAULT_COLORS[this._colorIdx % DEFAULT_COLORS.length];
    this._colorIdx += 1;
    return c;
  }

  _ensureBucket(instanceId) {
    let b = this.overlays.get(instanceId);
    if (!b) {
      b = {
        series: [], // { name, series, chart }
        priceLines: [],
        markersByOwner: new Map(),
        usesSubPane: false,
      };
      this.overlays.set(instanceId, b);
    }
    return b;
  }

  apply(instanceId, outputs) {
    this.remove(instanceId);
    if (!outputs || !outputs.length) return;
    const mainChart = this.chartManager.chart;
    const candleSeries = this.chartManager.candleSeries;
    if (!mainChart || !candleSeries) return;
    const bucket = this._ensureBucket(instanceId);
    let needsSubPane = false;

    for (const out of outputs) {
      if (out.kind === 'line' || out.kind === 'histogram' || out.kind === 'area') {
        const pane = paneOf(out.opts);
        if (pane >= 1) needsSubPane = true;
      }
    }
    if (needsSubPane) {
      this._acquireSubPane();
      bucket.usesSubPane = true;
    }

    for (const out of outputs) {
      if (out.kind === 'line' || out.kind === 'histogram' || out.kind === 'area') {
        const pane = paneOf(out.opts);
        const targetChart = pane >= 1 ? this._subPane?.chart || mainChart : mainChart;
        const seriesHandle = this._addSeriesForKind(targetChart, out);
        const data = (out.data || []).filter(
          (p) => Number.isFinite(p.value) && Number.isFinite(p.time),
        );
        if (data.length) seriesHandle.setData(data);
        bucket.series.push({ name: out.name, series: seriesHandle, chart: targetChart });
      } else if (out.kind === 'marker') {
        bucket.markersByOwner.set(out.name, out.markers || []);
      } else if (out.kind === 'hline') {
        const pl = candleSeries.createPriceLine({
          price: out.price,
          color: out.opts?.color || '#888',
          lineWidth: 1,
          title: out.opts?.title || '',
        });
        bucket.priceLines.push(pl);
      } else if (out.kind === 'alert') {
        for (const ev of out.events || []) this._emitAlert(instanceId, ev);
      } else if (out.kind === 'bgcolor') {
        this._setBgSegments(instanceId, out.segments || []);
      }
    }

    this._reapplyMarkers();
  }

  update(instanceId, deltas) {
    const bucket = this.overlays.get(instanceId);
    if (!bucket || !deltas || !deltas.length) return;
    for (const d of deltas) {
      if (d.kind === 'line' || d.kind === 'histogram' || d.kind === 'area') {
        const handle = bucket.series.find((s) => s.name === d.name);
        if (handle && d.point && Number.isFinite(d.point.value) && Number.isFinite(d.point.time)) {
          try {
            handle.series.update(d.point);
          } catch {
            /* swallow */
          }
        }
      } else if (d.kind === 'marker') {
        const prev = bucket.markersByOwner.get(d.name) || [];
        bucket.markersByOwner.set(d.name, prev.concat(d.markers || []));
      } else if (d.kind === 'alert') {
        for (const ev of d.events || []) this._emitAlert(instanceId, ev);
      } else if (d.kind === 'bgcolor') {
        this._appendBgSegment(instanceId, d.segment);
      }
    }
    this._reapplyMarkers();
  }

  remove(instanceId) {
    const bucket = this.overlays.get(instanceId);
    if (!bucket) return;
    const candleSeries = this.chartManager.candleSeries;
    for (const s of bucket.series) {
      try {
        s.chart?.removeSeries(s.series);
      } catch {
        /* ignore */
      }
    }
    for (const pl of bucket.priceLines) {
      try {
        candleSeries?.removePriceLine(pl);
      } catch {
        /* ignore */
      }
    }
    if (bucket.usesSubPane) this._releaseSubPane();
    this.overlays.delete(instanceId);
    this._bgSegmentsByInstance.delete(instanceId);
    this._reapplyBg();
    this._reapplyMarkers();
  }

  removeAll() {
    for (const id of Array.from(this.overlays.keys())) this.remove(id);
  }

  _ensureBgPrimitive() {
    if (this._bgPrimitive) return this._bgPrimitive;
    const candleSeries = this.chartManager?.candleSeries;
    if (!candleSeries || typeof candleSeries.attachPrimitive !== 'function') return null;
    this._bgPrimitive = new BgColorPrimitive();
    try {
      candleSeries.attachPrimitive(this._bgPrimitive);
    } catch {
      this._bgPrimitive = null;
    }
    return this._bgPrimitive;
  }

  _setBgSegments(instanceId, segments) {
    if (!segments.length) {
      this._bgSegmentsByInstance.delete(instanceId);
    } else {
      this._bgSegmentsByInstance.set(instanceId, segments.slice());
    }
    this._reapplyBg();
  }

  _appendBgSegment(instanceId, segment) {
    if (!segment) return;
    const arr = this._bgSegmentsByInstance.get(instanceId) || [];
    arr.push(segment);
    this._bgSegmentsByInstance.set(instanceId, arr);
    this._reapplyBg();
  }

  _reapplyBg() {
    if (!this._bgSegmentsByInstance.size) {
      if (this._bgPrimitive) this._bgPrimitive.clear();
      return;
    }
    const primitive = this._ensureBgPrimitive();
    if (!primitive) return;
    const merged = [];
    for (const arr of this._bgSegmentsByInstance.values()) {
      for (const seg of arr) merged.push(seg);
    }
    primitive.setSegments(merged);
  }

  _emitAlert(instanceId, event) {
    for (const fn of this.alertListeners) {
      try {
        fn({ instanceId, ...event });
      } catch {
        /* listener error — don't break script flow */
      }
    }
  }

  _addSeriesForKind(targetChart, out) {
    const color = out.opts?.color || this._autoColor();
    const width = clampWidth(out.opts?.lineWidth);
    if (out.kind === 'histogram') {
      return targetChart.addHistogramSeries({
        color,
        priceScaleId: 'right',
        lastValueVisible: false,
        priceLineVisible: false,
        title: out.name,
      });
    }
    if (out.kind === 'area') {
      return targetChart.addAreaSeries({
        lineColor: color,
        topColor: color,
        bottomColor: 'rgba(0,0,0,0)',
        lineWidth: width,
        priceScaleId: 'right',
        lastValueVisible: false,
        priceLineVisible: false,
        title: out.name,
      });
    }
    return targetChart.addLineSeries({
      color,
      lineWidth: width,
      priceScaleId: 'right',
      lastValueVisible: false,
      priceLineVisible: false,
      title: out.name,
    });
  }

  _reapplyMarkers() {
    const candleSeries = this.chartManager.candleSeries;
    if (!candleSeries) return;
    const merged = [];
    for (const bucket of this.overlays.values()) {
      for (const arr of bucket.markersByOwner.values()) {
        for (const m of arr) merged.push(toLwMarker(m));
      }
    }
    merged.sort((a, b) => a.time - b.time);
    try {
      candleSeries.setMarkers(merged);
    } catch {
      /* ignore */
    }
  }

  // ── Sub-pane lifecycle ────────────────────────────────────────────────────
  _acquireSubPane() {
    this._subPaneRefCount += 1;
    if (this._subPane) return;
    const anchor = document.getElementById('chart-container');
    if (!anchor || !anchor.parentNode) return;

    const container = document.createElement('div');
    container.id = 'nanopine-sub-pane';
    container.className = 'nanopine-sub-pane';
    container.style.height = `${SUB_PANE_HEIGHT_PX}px`;
    anchor.parentNode.insertBefore(container, anchor.nextSibling);

    const chart = createChart(container, {
      width: container.clientWidth || 600,
      height: SUB_PANE_HEIGHT_PX,
      layout: { background: { color: 'transparent' }, textColor: '#bbb' },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
      timeScale: {
        visible: false,
        borderVisible: false,
      },
      rightPriceScale: { borderVisible: false },
      crosshair: { mode: 1 },
      handleScale: { mouseWheel: false, pinch: false, axisPressedMouseMove: false },
      handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false },
    });

    const resizeObs = new ResizeObserver(() => {
      const w = container.clientWidth || 600;
      try {
        chart.applyOptions({ width: w, height: SUB_PANE_HEIGHT_PX });
      } catch {
        /* ignore */
      }
    });
    resizeObs.observe(container);

    this._subPane = { container, chart, resizeObs, syncing: false, anchor };
    this._wireTimeScaleSync();
  }

  _releaseSubPane() {
    this._subPaneRefCount = Math.max(0, this._subPaneRefCount - 1);
    if (this._subPaneRefCount > 0) return;
    if (!this._subPane) return;
    const { container, chart, resizeObs } = this._subPane;
    try {
      resizeObs.disconnect();
    } catch {
      /* ignore */
    }
    try {
      chart.remove();
    } catch {
      /* ignore */
    }
    try {
      container.parentNode?.removeChild(container);
    } catch {
      /* ignore */
    }
    this._subPane = null;
  }

  _wireTimeScaleSync() {
    if (!this._subPane) return;
    const mainChart = this.chartManager.chart;
    if (!mainChart) return;
    const mainScale = mainChart.timeScale();
    const subScale = this._subPane.chart.timeScale();

    const fromMain = (range) => {
      if (!range || !this._subPane || this._subPane.syncing) return;
      this._subPane.syncing = true;
      try {
        subScale.setVisibleLogicalRange(range);
      } catch {
        /* ignore */
      }
      this._subPane.syncing = false;
    };
    const fromSub = (range) => {
      if (!range || !this._subPane || this._subPane.syncing) return;
      this._subPane.syncing = true;
      try {
        mainScale.setVisibleLogicalRange(range);
      } catch {
        /* ignore */
      }
      this._subPane.syncing = false;
    };

    // Capture the current visible range immediately so the sub-pane lines up on creation.
    try {
      const cur = mainScale.getVisibleLogicalRange();
      if (cur) subScale.setVisibleLogicalRange(cur);
    } catch {
      /* ignore */
    }

    mainScale.subscribeVisibleLogicalRangeChange(fromMain);
    subScale.subscribeVisibleLogicalRangeChange(fromSub);
    this._timeScaleSyncBound = true;
  }
}

function paneOf(opts) {
  if (!opts || opts.pane == null) return 0;
  const n = Number(opts.pane);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function clampWidth(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 1.5;
  return Math.min(Math.max(n, 1), 4);
}

function toLwMarker(m) {
  const loc = m.location || 'aboveBar';
  return {
    time: m.time,
    position: loc === 'belowbar' ? 'belowBar' : loc === 'abovebar' ? 'aboveBar' : loc,
    color: m.color || '#ffb300',
    shape: mapShape(m.shape),
    text: m.title || '',
  };
}

function mapShape(s) {
  switch (s) {
    case 'triangleup':
      return 'arrowUp';
    case 'triangledown':
      return 'arrowDown';
    case 'circle':
      return 'circle';
    case 'square':
      return 'square';
    case 'cross':
      return 'cross';
    default:
      return 'circle';
  }
}

/**
 * @typedef OverlayBucket
 * @property {{name: string, series: any, chart: any}[]} series
 * @property {any[]} priceLines
 * @property {Map<string, any[]>} markersByOwner
 * @property {boolean} usesSubPane
 */
