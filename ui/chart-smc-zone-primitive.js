/**
 * Lightweight Charts series primitive: shaded SMC rectangles (order block, FVG) + labels,
 * plus horizontal BOS / CHoCH segments (swing → confirmation bar).
 * @see https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesPrimitive
 */

const MIN_ZONE_WIDTH_PX = 56;

export class SmcZoneBoxesPrimitive {
  constructor() {
    /** @type {{ t1: number; t2: number; top: number; bottom: number; fill: string; stroke?: string; text?: string; textColor?: string }[]} */
    this.zones = [];
    /** @type {{ t1: number; t2: number; price: number; color: string; label?: string; lineWidth?: number }[]} */
    this.lines = [];
    /** @type {import('lightweight-charts').IChartApi | null} */
    this._chart = null;
    /** @type {import('lightweight-charts').ISeriesApi<'Candlestick'> | null} */
    this._series = null;
    /** @type {(() => void) | null} */
    this._requestUpdate = null;
    this._paneView = new SmcZonesPaneView(this);
    this._onRange = () => {
      this._requestUpdate?.();
    };
  }

  /** @param {typeof this.zones} zones */
  setZones(zones) {
    this.zones = Array.isArray(zones) ? zones : [];
    this._requestUpdate?.();
  }

  /** @param {typeof this.lines} lines */
  setLines(lines) {
    this.lines = Array.isArray(lines) ? lines : [];
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

class SmcZonesPaneView {
  /** @param {SmcZoneBoxesPrimitive} host */
  constructor(host) {
    this._host = host;
  }

  zOrder() {
    return 'bottom';
  }

  renderer() {
    const zones = this._host.zones;
    const lines = this._host.lines;
    const series = this._host._series;
    const chart = this._host._chart;
    if ((!zones.length && !lines.length) || !series || !chart) return null;
    const timeScale = chart.timeScale();
    return {
      draw: (target) => {
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          for (const z of zones) {
            const x1 = timeScale.timeToCoordinate(z.t1);
            const x2 = timeScale.timeToCoordinate(z.t2);
            if (x1 == null || x2 == null) continue;
            const yTop = series.priceToCoordinate(z.top);
            const yBot = series.priceToCoordinate(z.bottom);
            if (yTop == null || yBot == null) continue;
            let left = Math.min(x1, x2);
            let right = Math.max(x1, x2);
            const top = Math.min(yTop, yBot);
            const bottom = Math.max(yTop, yBot);
            if (right - left < MIN_ZONE_WIDTH_PX) {
              right = left + MIN_ZONE_WIDTH_PX;
            }
            right = Math.min(right, mediaSize.width - 4);
            if (left >= mediaSize.width - 2) continue;
            const w = Math.max(1, right - left);
            const h = Math.max(1, bottom - top);
            ctx.fillStyle = z.fill;
            ctx.fillRect(left, top, w, h);
            if (z.stroke) {
              ctx.strokeStyle = z.stroke;
              ctx.lineWidth = 1;
              ctx.strokeRect(left, top, w, h);
            }
            if (z.text) {
              ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
              ctx.fillStyle = z.textColor || 'rgba(197,202,233,0.95)';
              ctx.fillText(z.text, left + 4, top + 14);
            }
          }

          for (const ln of lines) {
            const x1 = timeScale.timeToCoordinate(ln.t1);
            const x2 = timeScale.timeToCoordinate(ln.t2);
            const y = series.priceToCoordinate(ln.price);
            if (x1 == null || x2 == null || y == null) continue;
            const left = Math.min(x1, x2);
            const right = Math.max(x1, x2);
            if (right <= left || left >= mediaSize.width - 1) continue;
            ctx.strokeStyle = ln.color;
            ctx.lineWidth = ln.lineWidth ?? 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(Math.min(right, mediaSize.width - 1), y);
            ctx.stroke();
            if (ln.label) {
              const pad = 4;
              ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
              ctx.fillStyle = ln.color;
              const metrics = ctx.measureText(ln.label);
              
              // Horizontally center the label
              let tx = (left + right) / 2 - metrics.width / 2;
              
              // Ensure it doesn't clip off the screen on either side
              if (tx < left + pad) tx = left + pad;
              const maxTx = Math.min(right, mediaSize.width) - metrics.width - pad;
              if (tx > maxTx) tx = maxTx;

              // Vertical position: 'top' goes above the line, 'bottom' goes below
              const ty = ln.position === 'bottom' ? y + 14 : y - 5;
              
              ctx.fillText(ln.label, tx, ty);
            }
          }
        });
      },
    };
  }
}
