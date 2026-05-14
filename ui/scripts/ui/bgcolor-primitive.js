// Lightweight Charts series primitive that paints colored vertical strips per bar
// to render `bgcolor(...)` calls from NanoPine scripts. One primitive instance is
// attached to the candlestick series; multiple scripts contribute segments that all
// get merged into the same primitive (last-write-wins per time).

export class BgColorPrimitive {
  constructor() {
    /** @type {Map<number, { color: string; opacity?: number }>} */
    this.byTime = new Map();
    /** @type {import('lightweight-charts').IChartApi | null} */
    this._chart = null;
    /** @type {import('lightweight-charts').ISeriesApi<'Candlestick'> | null} */
    this._series = null;
    /** @type {(() => void) | null} */
    this._requestUpdate = null;
    this._paneView = new BgColorPaneView(this);
    this._onRange = () => this._requestUpdate?.();
  }

  setSegments(segments) {
    this.byTime.clear();
    if (!Array.isArray(segments)) return this._requestUpdate?.();
    for (const seg of segments) {
      if (!seg || !Number.isFinite(seg.time)) continue;
      if (!seg.color) continue;
      this.byTime.set(Math.floor(seg.time), { color: seg.color, opacity: seg.opacity });
    }
    this._requestUpdate?.();
  }

  upsertSegment(seg) {
    if (!seg || !Number.isFinite(seg.time) || !seg.color) return;
    this.byTime.set(Math.floor(seg.time), { color: seg.color, opacity: seg.opacity });
    this._requestUpdate?.();
  }

  clear() {
    this.byTime.clear();
    this._requestUpdate?.();
  }

  attached(param) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    param.chart.timeScale().subscribeVisibleTimeRangeChange(this._onRange);
    param.chart.timeScale().subscribeVisibleLogicalRangeChange(this._onRange);
  }

  detached() {
    if (this._chart) {
      this._chart.timeScale().unsubscribeVisibleTimeRangeChange(this._onRange);
      this._chart.timeScale().unsubscribeVisibleLogicalRangeChange(this._onRange);
    }
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews() {
    return [this._paneView];
  }
}

class BgColorPaneView {
  constructor(host) {
    this._host = host;
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    const host = this._host;
    if (!host.byTime.size || !host._chart) return null;
    const chart = host._chart;
    const timeScale = chart.timeScale();
    return {
      draw: (target) => {
        target.useBitmapCoordinateSpace((scope) => {
          const ctx = scope.context;
          const dpr = scope.horizontalPixelRatio || 1;
          const dprY = scope.verticalPixelRatio || 1;
          const height = scope.bitmapSize.height;
          // Approximate per-bar width: prefer the configured barSpacing, fall back
          // to the average of adjacent visible times.
          let barWidthPx = 0;
          try {
            const opts = timeScale.options();
            if (opts && Number.isFinite(opts.barSpacing)) barWidthPx = opts.barSpacing;
          } catch {
            /* ignore */
          }
          if (!barWidthPx || barWidthPx < 1) barWidthPx = 6;
          const halfPx = barWidthPx / 2;
          ctx.save();
          for (const [time, info] of host.byTime.entries()) {
            const x = timeScale.timeToCoordinate(time);
            if (x == null || !Number.isFinite(x)) continue;
            const fill = applyOpacity(info.color, info.opacity);
            ctx.fillStyle = fill;
            const left = Math.round((x - halfPx) * dpr);
            const right = Math.round((x + halfPx) * dpr);
            ctx.fillRect(left, 0, Math.max(1, right - left), height * dprY);
          }
          ctx.restore();
        });
      },
    };
  }
}

function applyOpacity(color, opacity) {
  if (opacity == null || !Number.isFinite(opacity)) return color;
  const a = Math.max(0, Math.min(1, opacity));
  // Try to parse common color forms; fall back to the original color.
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const r = parseInt(hex[1].slice(0, 2), 16);
    const g = parseInt(hex[1].slice(2, 4), 16);
    const b = parseInt(hex[1].slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  const rgb = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (rgb) {
    return `rgba(${rgb[1]},${rgb[2]},${rgb[3]},${a})`;
  }
  const named = NAMED_COLORS[color.toLowerCase()];
  if (named) return `rgba(${named.r},${named.g},${named.b},${a})`;
  return color;
}

const NAMED_COLORS = {
  red: { r: 239, g: 83, b: 80 },
  green: { r: 38, g: 166, b: 154 },
  lime: { r: 156, g: 204, b: 101 },
  blue: { r: 66, g: 165, b: 245 },
  yellow: { r: 255, g: 235, b: 59 },
  orange: { r: 255, g: 152, b: 0 },
  purple: { r: 171, g: 71, b: 188 },
  magenta: { r: 236, g: 64, b: 122 },
  cyan: { r: 38, g: 198, b: 218 },
  white: { r: 240, g: 240, b: 240 },
  gray: { r: 158, g: 158, b: 158 },
  grey: { r: 158, g: 158, b: 158 },
  black: { r: 30, g: 30, b: 30 },
};
