import { createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from './provider-client';

export class ChartView {
  private chart: IChartApi;
  private series: ISeriesApi<'Candlestick'>;
  private volume: ISeriesApi<'Histogram'>;
  private resizeObs: ResizeObserver;

  constructor(container: HTMLElement) {
    this.chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: { background: { color: '#0d1117' }, textColor: '#8b949e' },
      grid: {
        vertLines: { color: '#1f2630' },
        horzLines: { color: '#1f2630' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: '#30363d',
      },
      rightPriceScale: { borderColor: '#30363d' },
      crosshair: { mode: 1 },
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
    const cs = candles
      .map((c) => ({ time: (c.openTime / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    const vs = candles
      .map((c) => ({ time: (c.openTime / 1000) as UTCTimestamp, value: c.volume, color: c.close >= c.open ? '#193f2a' : '#4a1d20' }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    this.series.setData(cs);
    this.volume.setData(vs);
    this.chart.timeScale().fitContent();
  }

  updateCandle(c: Candle): void {
    const t = (c.openTime / 1000) as UTCTimestamp;
    this.series.update({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
    this.volume.update({ time: t, value: c.volume, color: c.close >= c.open ? '#193f2a' : '#4a1d20' });
  }

  dispose(): void {
    this.resizeObs.disconnect();
    this.chart.remove();
  }
}
