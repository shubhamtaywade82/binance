/**
 * Lightweight Charts series primitive: shaded SMC rectangles (order block, FVG) + labels,
 * plus horizontal BOS / CHoCH segments (swing → confirmation bar).
 * @see https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesPrimitive
 */

const MIN_ZONE_WIDTH_PX = 56;

export class SmcZoneBoxesPrimitive {
  constructor() {
    this.zones = [];
    this.lines = [];
    this._chart = null;
    this._series = null;
    this._requestUpdate = null;
    this._paneView = new SmcZonesPaneView(this);
    this._onRange = () => {
      this._requestUpdate?.();
    };
  }

  setZones(zones) {
    this.zones = Array.isArray(zones) ? zones : [];
    this._requestUpdate?.();
  }

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
    if (!series || !chart) return null;
    if (!zones.length && !lines.length) return null;
    
    const timeScale = chart.timeScale();
    
    return {
      draw: (target) => {
        try {
          target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hRp, verticalPixelRatio: vRp }) => {
            const getVisibleRange = () => {
              const r = timeScale.getVisibleRange();
              if (!r) return null;
              const from = (typeof r.from === 'number') ? r.from : (r.from.year ? new Date(r.from.year, r.from.month - 1, r.from.day).getTime() / 1000 : null);
              const to = (typeof r.to === 'number') ? r.to : (r.to.year ? new Date(r.to.year, r.to.month - 1, r.to.day).getTime() / 1000 : null);
              if (from === null || to === null) return null;
              return { from, to };
            };

            const vRange = getVisibleRange();
            if (!vRange) return;

            const getX = (t) => {
              const xCss = timeScale.timeToCoordinate(t);
              if (xCss !== null) return xCss * hRp;
              
              if (t > vRange.to) return bitmapSize.width + (100 * hRp);
              if (t < vRange.from) return -100 * hRp;
              
              const totalTime = vRange.to - vRange.from;
              if (totalTime <= 0) return null;
              const ratio = (t - vRange.from) / totalTime;
              return ratio * bitmapSize.width;
            };

            const getY = (p) => {
              const yCss = series.priceToCoordinate(p);
              return yCss !== null ? yCss * vRp : null;
            };

            for (const z of zones) {
              const x1 = getX(z.t1);
              const x2 = getX(z.t2);
              const y1 = getY(z.top);
              const y2 = getY(z.bottom);
              
              if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
              
              const left = Math.min(x1, x2);
              const right = Math.max(x1, x2);
              const top = Math.min(y1, y2);
              const bottom = Math.max(y1, y2);
              
              const w = Math.max(1, right - left);
              const h = Math.max(1, bottom - top);

              ctx.fillStyle = z.fill;
              ctx.fillRect(left, top, w, h);
              
              if (typeof z.tankRatio === 'number' && z.tankRatio >= 0) {
                const ratio = Math.min(1.0, z.tankRatio);
                ctx.fillStyle = z.stroke || z.fill; 
                ctx.save();
                ctx.globalAlpha = 0.5;
                ctx.fillRect(left, top, w * ratio, h);
                ctx.restore();
              }

              if (z.stroke) {
                ctx.strokeStyle = z.stroke;
                ctx.lineWidth = Math.max(1, hRp);
                ctx.strokeRect(left, top, w, h);
              }

              if (z.text) {
                const fontSize = 11 * vRp;
                ctx.font = `bold ${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;
                ctx.fillStyle = z.textColor || 'rgba(255,255,255,0.9)';
                const metrics = ctx.measureText(z.text);
                let tx = left + (4 * hRp);
                if (z.labelAlign === 'right') tx = right - metrics.width - (4 * hRp);
                else if (z.labelAlign === 'center') tx = left + w / 2 - metrics.width / 2;
                tx = Math.max(4 * hRp, Math.min(bitmapSize.width - metrics.width - (4 * hRp), tx));
                ctx.fillText(z.text, tx, top + (14 * vRp));
              }
            }

            for (const ln of lines) {
              const x1 = getX(ln.t1);
              const x2 = getX(ln.t2);
              const y = getY(ln.price);
              if (x1 === null || x2 === null || y === null) continue;
              
              const left = Math.min(x1, x2);
              const right = Math.max(x1, x2);
              
              ctx.strokeStyle = ln.color;
              ctx.lineWidth = (ln.lineWidth ?? 1.5) * hRp;
              
              ctx.save();
              if (ln.lineStyle === 1) ctx.setLineDash([6 * hRp, 4 * hRp]);
              else if (ln.lineStyle === 2) ctx.setLineDash([2 * hRp, 2 * hRp]);
              else ctx.setLineDash([]);

              ctx.beginPath();
              ctx.moveTo(left, y);
              ctx.lineTo(right, y);
              ctx.stroke();
              ctx.restore();

              if (ln.label) {
                const fontSize = 11 * vRp;
                ctx.font = `bold ${fontSize}px 'JetBrains Mono', ui-monospace, monospace`;
                ctx.fillStyle = ln.color;
                const metrics = ctx.measureText(ln.label);
                let tx = (left + right) / 2 - metrics.width / 2;
                tx = Math.max(left + (4 * hRp), Math.min(right - metrics.width - (4 * hRp), tx));
                const ty = ln.position === 'bottom' ? y + (14 * vRp) : y - (5 * vRp);
                ctx.fillText(ln.label, tx, ty);
              }
            }
          });
        } catch (e) {
          console.error('[SmcZonesPaneView] draw error:', e);
        }
      },
    };
  }
}
