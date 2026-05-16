/**
 * Lightweight Charts series primitive: dashed horizontal price lines that start
 * at a specific candle time and extend to the right edge of the chart pane
 * (touching the price scale). Each line has an invisible `createPriceLine` on
 * the host series for the titled axis label.
 *
 * @see https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesPrimitive
 */
import { LineStyle } from 'lightweight-charts';

export class PartialPriceLinesPrimitive {
  constructor() {
    /** @type {Array<{ id: string; startTimeSec: number; price: number; color: string; lineWidth?: number; dash?: number[] }>} */
    this._lines = [];
    /** @type {Map<string, import('lightweight-charts').IPriceLine>} */
    this._labelLines = new Map();
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._paneView = new PartialLinesPaneView(this);
  }

  attached(param) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached() {
    this._removeAllLabelLines();
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
  }

  paneViews() {
    return [this._paneView];
  }

  /**
   * @param {string} id
   * @param {{ startTimeSec: number; price: number; color: string; lineWidth?: number;
   *           dash?: number[]; title?: string; axisLabelColor?: string; axisLabelTextColor?: string }} opts
   */
  setLine(id, opts) {
    const idx = this._lines.findIndex((l) => l.id === id);
    const entry = { id, ...opts };
    if (idx >= 0) this._lines[idx] = entry;
    else this._lines.push(entry);
    this._syncLabelLine(id, opts);
    this._requestUpdate?.();
  }

  removeLine(id) {
    this._lines = this._lines.filter((l) => l.id !== id);
    this._removeLabelLine(id);
    this._requestUpdate?.();
  }

  clear() {
    this._lines = [];
    this._removeAllLabelLines();
    this._requestUpdate?.();
  }

  _syncLabelLine(id, opts) {
    if (!this._series) return;
    const existing = this._labelLines.get(id);
    if (existing) {
      existing.applyOptions({
        price: opts.price,
        title: opts.title ?? '',
        axisLabelColor: opts.axisLabelColor ?? 'rgba(136,146,164,0.9)',
        axisLabelTextColor: opts.axisLabelTextColor ?? '#c8cdd5',
      });
      if (opts.axisLabelColor) existing.applyOptions({ axisLabelColor: opts.axisLabelColor });
      if (opts.axisLabelTextColor) existing.applyOptions({ axisLabelTextColor: opts.axisLabelTextColor });
      return;
    }
    const pl = this._series.createPriceLine({
      price: opts.price,
      color: 'rgba(0,0,0,0)',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: false,
      axisLabelVisible: true,
      title: opts.title ?? '',
      axisLabelColor: opts.axisLabelColor ?? 'rgba(136,146,164,0.9)',
      axisLabelTextColor: opts.axisLabelTextColor ?? '#c8cdd5',
    });
    this._labelLines.set(id, pl);
  }

  _removeLabelLine(id) {
    const pl = this._labelLines.get(id);
    if (pl && this._series) {
      try { this._series.removePriceLine(pl); } catch { /* ignore */ }
    }
    this._labelLines.delete(id);
  }

  _removeAllLabelLines() {
    for (const [id] of this._labelLines) this._removeLabelLine(id);
    this._labelLines.clear();
  }
}

class PartialLinesPaneView {
  constructor(host) {
    this._host = host;
  }

  zOrder() {
    return 'top';
  }

  renderer() {
    const lines = this._host._lines;
    const series = this._host._series;
    const chart = this._host._chart;
    if (!series || !chart || !lines.length) return null;

    const timeScale = chart.timeScale();

    return {
      draw: (target) => {
        try {
          target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hRp, verticalPixelRatio: vRp }) => {
            const rightEdge = bitmapSize.width;

            for (const ln of lines) {
              const yCss = series.priceToCoordinate(ln.price);
              if (yCss === null) continue;
              const y = Math.round(yCss * vRp) + 0.5;

              let xStart;
              if (ln.extendLeft) {
                xStart = 0;
              } else {
                const xCss = timeScale.timeToCoordinate(ln.startTimeSec);
                if (xCss !== null) {
                  xStart = xCss * hRp;
                } else {
                  xStart = 0;
                }
              }

              if (xStart >= rightEdge) continue;

              ctx.save();
              ctx.strokeStyle = ln.color;
              ctx.lineWidth = (ln.lineWidth ?? 1) * hRp;
              if (ln.dash) {
                ctx.setLineDash(ln.dash.map((d) => d * hRp));
              } else {
                ctx.setLineDash([6 * hRp, 4 * hRp]);
              }
              ctx.beginPath();
              ctx.moveTo(xStart, y);
              ctx.lineTo(rightEdge, y);
              ctx.stroke();
              ctx.restore();
            }
          });
        } catch (e) {
          console.error('[PartialLinesPaneView] draw error:', e);
        }
      },
    };
  }
}
