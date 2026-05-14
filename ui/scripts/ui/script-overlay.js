// ChartOverlayManager — owns lightweight-charts series, markers, and price lines
// that are produced by user scripts. One overlay manager spans many script instances;
// instance teardown removes all series owned by that instance atomically.

const DEFAULT_COLORS = ['#26a69a', '#ef5350', '#ffb300', '#42a5f5', '#ab47bc', '#9ccc65', '#ec407a', '#26c6da'];

export class ChartOverlayManager {
  constructor(chartManager) {
    this.chartManager = chartManager;
    /** @type {Map<string, { series: any[]; priceLines: any[]; markerOwners: any[]; }>} */
    this.overlays = new Map();
    this._colorIdx = 0;
  }

  _autoColor() {
    const c = DEFAULT_COLORS[this._colorIdx % DEFAULT_COLORS.length];
    this._colorIdx += 1;
    return c;
  }

  _ensureBucket(instanceId) {
    let b = this.overlays.get(instanceId);
    if (!b) {
      b = { series: [], priceLines: [], markerOwners: [], markersByOwner: new Map() };
      this.overlays.set(instanceId, b);
    }
    return b;
  }

  apply(instanceId, outputs) {
    this.remove(instanceId);
    if (!outputs || !outputs.length) return;
    const chart = this.chartManager.chart;
    const candleSeries = this.chartManager.candleSeries;
    if (!chart || !candleSeries) return;
    const bucket = this._ensureBucket(instanceId);

    for (const out of outputs) {
      if (out.kind === 'line') {
        const color = out.opts?.color || this._autoColor();
        const width = clampWidth(out.opts?.lineWidth);
        const series = chart.addLineSeries({
          color,
          lineWidth: width,
          priceScaleId: 'right',
          lastValueVisible: false,
          priceLineVisible: false,
          title: out.name,
        });
        const data = (out.data || []).filter(
          (p) => Number.isFinite(p.value) && Number.isFinite(p.time),
        );
        if (data.length) series.setData(data);
        bucket.series.push({ name: out.name, series });
      } else if (out.kind === 'marker') {
        bucket.markerOwners.push(out.name);
        bucket.markersByOwner.set(out.name, out.markers || []);
      } else if (out.kind === 'hline') {
        const pl = candleSeries.createPriceLine({
          price: out.price,
          color: out.opts?.color || '#888',
          lineWidth: 1,
          title: out.opts?.title || '',
        });
        bucket.priceLines.push(pl);
      } else if (out.kind === 'bgcolor') {
        // bgcolor is intentionally unrendered in MVP — lightweight-charts v4 has no
        // native background-by-time. Phase 2 can add a CanvasOverlay primitive.
      }
    }

    this._reapplyMarkers();
  }

  update(instanceId, deltas) {
    const bucket = this.overlays.get(instanceId);
    if (!bucket || !deltas || !deltas.length) return;
    for (const d of deltas) {
      if (d.kind === 'line') {
        const handle = bucket.series.find((s) => s.name === d.name);
        if (handle && d.point && Number.isFinite(d.point.value) && Number.isFinite(d.point.time)) {
          try {
            handle.series.update(d.point);
          } catch {
            /* swallow — caller will recompile on next major change */
          }
        }
      } else if (d.kind === 'marker') {
        const prev = bucket.markersByOwner.get(d.name) || [];
        bucket.markersByOwner.set(d.name, prev.concat(d.markers || []));
      } else if (d.kind === 'hline') {
        // Replace the most recent priceLine of this script. For MVP we just leave the
        // initial one — hline price changes are infrequent and re-applying requires
        // tracking owner → priceLine which can wait for Phase 2.
      }
    }
    this._reapplyMarkers();
  }

  remove(instanceId) {
    const bucket = this.overlays.get(instanceId);
    if (!bucket) return;
    const chart = this.chartManager.chart;
    const candleSeries = this.chartManager.candleSeries;
    for (const s of bucket.series) {
      try {
        chart?.removeSeries(s.series);
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
    this.overlays.delete(instanceId);
    this._reapplyMarkers();
  }

  removeAll() {
    for (const id of Array.from(this.overlays.keys())) this.remove(id);
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
