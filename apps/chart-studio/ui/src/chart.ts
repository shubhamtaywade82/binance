import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineWidth,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from './provider-client';
import type { ActiveIndicator } from './indicators/registry';
import { INDICATORS, type Pane, type SeriesSpec } from './indicators/registry';

interface ManagedSeries {
  pane: Pane;
  series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
}

interface IndicatorHandle {
  active: ActiveIndicator;
  series: ManagedSeries[];
}

/**
 * One chart instance with optional separate panes for RSI / MACD. The
 * library doesn't yet expose multi-pane natively in v4, so we stack
 * extra series via custom price-scale ids and scale margins.
 */
export class ChartView {
  private chart: IChartApi;
  private series: ISeriesApi<'Candlestick'>;
  private volume: ISeriesApi<'Histogram'>;
  private candles: Candle[] = [];
  private indicators = new Map<string, IndicatorHandle>(); // uid -> handle
  private resizeObs: ResizeObserver;
  private rsiActive = false;
  private macdActive = false;

  constructor(container: HTMLElement) {
    this.chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: {
        vertLines: { color: '#1f2630' },
        horzLines: { color: '#1f2630' },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#30363d' },
      rightPriceScale: { borderColor: '#30363d' },
      crosshair: { mode: CrosshairMode.Normal },
    });
    this.series = this.chart.addCandlestickSeries({
      upColor: '#3fb950', borderUpColor: '#3fb950', wickUpColor: '#3fb950',
      downColor: '#f85149', borderDownColor: '#f85149', wickDownColor: '#f85149',
    });
    this.volume = this.chart.addHistogramSeries({
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      color: '#30363d',
    });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    this.series.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.2 } });

    this.resizeObs = new ResizeObserver(() => {
      this.chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    this.resizeObs.observe(container);
  }

  setHistory(candles: Candle[]): void {
    this.candles = [...candles].sort((a, b) => a.openTime - b.openTime);
    const cs = this.candles.map((c) => ({
      time: (c.openTime / 1000) as UTCTimestamp,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const vs = this.candles.map((c) => ({
      time: (c.openTime / 1000) as UTCTimestamp,
      value: c.volume,
      color: c.close >= c.open ? '#193f2a' : '#4a1d20',
    }));
    this.series.setData(cs);
    this.volume.setData(vs);
    this.recomputeIndicators();
    this.chart.timeScale().fitContent();
  }

  updateCandle(c: Candle): void {
    const t = (c.openTime / 1000) as UTCTimestamp;
    this.series.update({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
    this.volume.update({ time: t, value: c.volume, color: c.close >= c.open ? '#193f2a' : '#4a1d20' });

    const last = this.candles[this.candles.length - 1];
    if (last && last.openTime === c.openTime) this.candles[this.candles.length - 1] = c;
    else this.candles.push(c);

    // For an in-flight bar, indicators recompute the last value cheaply.
    this.recomputeIndicators();
  }

  // ── Indicator management ─────────────────────────────────────────────

  setIndicators(list: ActiveIndicator[]): void {
    const seen = new Set<string>();
    for (const ind of list) {
      seen.add(ind.uid);
      const existing = this.indicators.get(ind.uid);
      if (existing && existing.active.defId === ind.defId && shallowEq(existing.active.params, ind.params)) continue;
      if (existing) this.removeIndicator(ind.uid);
      this.addIndicator(ind);
    }
    for (const uid of [...this.indicators.keys()]) {
      if (!seen.has(uid)) this.removeIndicator(uid);
    }
    this.applyPaneLayout();
    this.recomputeIndicators();
  }

  private addIndicator(active: ActiveIndicator): void {
    const def = INDICATORS.find((d) => d.id === active.defId);
    if (!def) return;
    const specs = def.compute([], active.params); // peek shape; values computed in recompute
    const series: ManagedSeries[] = specs.map((spec) => this.createSeriesForSpec(spec));
    this.indicators.set(active.uid, { active, series });
  }

  private removeIndicator(uid: string): void {
    const h = this.indicators.get(uid);
    if (!h) return;
    for (const s of h.series) {
      try { this.chart.removeSeries(s.series); } catch { /* noop */ }
    }
    this.indicators.delete(uid);
  }

  private createSeriesForSpec(spec: SeriesSpec): ManagedSeries {
    const opts: { color: string; lineWidth: LineWidth; lastValueVisible: boolean; priceLineVisible: boolean; lineStyle: LineStyle; priceScaleId?: string } = {
      color: spec.color,
      lineWidth: 1 as LineWidth,
      lastValueVisible: spec.pane === 'overlay',
      priceLineVisible: false,
      lineStyle: LineStyle.Solid,
    };
    if (spec.priceScaleId) opts.priceScaleId = spec.priceScaleId;
    let series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
    if (spec.kind === 'histogram') {
      series = this.chart.addHistogramSeries({ color: spec.color, priceScaleId: spec.priceScaleId });
    } else {
      series = this.chart.addLineSeries(opts);
    }
    return { pane: spec.pane, series };
  }

  private applyPaneLayout(): void {
    this.rsiActive = false;
    this.macdActive = false;
    for (const h of this.indicators.values()) {
      for (const s of h.series) {
        if (s.pane === 'rsi') this.rsiActive = true;
        if (s.pane === 'macd') this.macdActive = true;
      }
    }
    const oscillators = (this.rsiActive ? 1 : 0) + (this.macdActive ? 1 : 0);
    const oscFraction = oscillators === 0 ? 0 : oscillators === 1 ? 0.22 : 0.34;
    const top = 0.05;
    const bottom = 0.05 + oscFraction;
    this.series.priceScale().applyOptions({ scaleMargins: { top, bottom } });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 1 - bottom - 0.05, bottom: oscFraction } });

    if (this.rsiActive) {
      this.chart.priceScale('rsi').applyOptions({
        scaleMargins: { top: 1 - bottom + 0.01, bottom: this.macdActive ? oscFraction / 2 : 0.02 },
      });
    }
    if (this.macdActive) {
      this.chart.priceScale('macd').applyOptions({
        scaleMargins: { top: 1 - (oscFraction / 2) + 0.01, bottom: 0.02 },
      });
    }
  }

  private recomputeIndicators(): void {
    if (this.candles.length === 0) return;
    for (const h of this.indicators.values()) {
      const def = INDICATORS.find((d) => d.id === h.active.defId);
      if (!def) continue;
      const specs = def.compute(this.candles, h.active.params);
      for (let i = 0; i < h.series.length; i += 1) {
        const spec = specs[i];
        const ms = h.series[i];
        if (!spec || !ms) continue;
        const data = this.candles.map((c, idx) => ({
          time: (c.openTime / 1000) as UTCTimestamp,
          value: Number.isFinite(spec.values[idx]) ? (spec.values[idx] as number) : NaN,
        })).filter((p) => Number.isFinite(p.value));
        if (spec.kind === 'histogram') {
          (ms.series as ISeriesApi<'Histogram'>).setData(data as { time: UTCTimestamp; value: number }[]);
        } else {
          (ms.series as ISeriesApi<'Line'>).setData(data as { time: UTCTimestamp; value: number }[]);
        }
      }
    }
  }

  // ── Markers (for NanoPine plots/alerts/etc) ─────────────────────────

  setMarkers(markers: SeriesMarker<UTCTimestamp>[]): void {
    this.series.setMarkers(markers);
  }

  // ── Drawing tool helpers ────────────────────────────────────────────

  /** Convert a screen Y at the chart container into a price. */
  yToPrice(y: number): number | null {
    return this.series.coordinateToPrice(y);
  }

  /** Convert price to screen Y. */
  priceToY(price: number): number | null {
    return this.series.priceToCoordinate(price);
  }

  /** Convert screen X to bar time (UTCTimestamp seconds). */
  xToTime(x: number): UTCTimestamp | null {
    return this.chart.timeScale().coordinateToTime(x) as UTCTimestamp | null;
  }

  timeToX(time: UTCTimestamp): number | null {
    return this.chart.timeScale().timeToCoordinate(time);
  }

  api(): IChartApi { return this.chart; }
  mainSeries(): ISeriesApi<'Candlestick'> { return this.series; }

  dispose(): void {
    this.resizeObs.disconnect();
    this.chart.remove();
  }
}

const shallowEq = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
};
