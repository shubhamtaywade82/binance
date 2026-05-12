/**
 * chart.js — TradingView Lightweight Charts integration
 * Handles: candlestick, volume, EMA 9/21/50, supertrend, MACD
 */

const COLORS = {
  bull: '#00e676',
  bear: '#ff1744',
  accent: '#7c4dff',
  ema9: '#ffd740',
  ema21: '#00b0ff',
  ema50: '#ff9100',
  bg: '#080b14',
  grid: 'rgba(255,255,255,0.04)',
  text: '#8892a4',
  crosshair: 'rgba(255,255,255,0.15)',
};

const CHART_OPTS = {
  layout: {
    background: { type: 'solid', color: 'transparent' },
    textColor: COLORS.text,
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
  },
  grid: {
    vertLines: { color: COLORS.grid },
    horzLines: { color: COLORS.grid },
  },
  crosshair: {
    mode: 1,
    vertLine: { color: COLORS.crosshair, width: 1, style: 3, labelBackgroundColor: '#1a2035' },
    horzLine: { color: COLORS.crosshair, width: 1, style: 3, labelBackgroundColor: '#1a2035' },
  },
  rightPriceScale: {
    borderColor: 'rgba(255,255,255,0.06)',
    textColor: COLORS.text,
    scaleMargins: { top: 0.08, bottom: 0.28 },
  },
  timeScale: {
    borderColor: 'rgba(255,255,255,0.06)',
    timeVisible: true,
    secondsVisible: false,
  },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
  handleScale:  { mouseWheel: true, pinch: true },
};

export class ChartManager {
  constructor(containerId, macdContainerId) {
    this.containerId = containerId;
    this.macdContainerId = macdContainerId;
    this.chart = null;
    this.macdChart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.ema9Series = null;
    this.ema21Series = null;
    this.ema50Series = null;
    this.stSeries = null;
    this.macdHistSeries = null;
    this.macdLineSeries = null;
    this.macdSignalSeries = null;
    this.currentTf = '5m';
    this.candleMap = {};   // tf → candle[] cache
    this.indicMap = {};    // tf → indicators cache
    this.showEma = true;
    this.showVolume = true;
    this.showSupertrend = true;
    this._resizeObs = null;
  }

  init() {
    const container = document.getElementById(this.containerId);
    const macdEl    = document.getElementById(this.macdContainerId);

    // Main chart
    this.chart = LightweightCharts.createChart(container, {
      ...CHART_OPTS,
      width: container.clientWidth,
      height: container.clientHeight,
    });

    // Candle series
    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: COLORS.bull,
      downColor: COLORS.bear,
      borderUpColor: COLORS.bull,
      borderDownColor: COLORS.bear,
      wickUpColor: COLORS.bull,
      wickDownColor: COLORS.bear,
    });

    // Volume (histogram on price scale 'volume')
    this.volumeSeries = this.chart.addHistogramSeries({
      color: COLORS.bull,
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      scaleMargins: { top: 0.75, bottom: 0 },
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

    // EMA series
    this.ema9Series  = this._addLineSeries(COLORS.ema9, 1, 'EMA9');
    this.ema21Series = this._addLineSeries(COLORS.ema21, 1, 'EMA21');
    this.ema50Series = this._addLineSeries(COLORS.ema50, 1.5, 'EMA50');

    // Supertrend — dashed line
    this.stSeries = this.chart.addLineSeries({
      color: COLORS.bull, lineWidth: 1.5, lineStyle: 2,
      priceScaleId: 'right',
      lastValueVisible: false, priceLineVisible: false,
    });

    // MACD chart
    this.macdChart = LightweightCharts.createChart(macdEl, {
      ...CHART_OPTS,
      width: macdEl.clientWidth,
      height: macdEl.clientHeight,
      rightPriceScale: { ...CHART_OPTS.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { ...CHART_OPTS.timeScale, visible: false },
    });
    this.macdHistSeries = this.macdChart.addHistogramSeries({
      color: COLORS.accent, priceScaleId: 'right',
      lastValueVisible: false, priceLineVisible: false,
    });
    this.macdLineSeries   = this._addLineSeries(COLORS.ema9, 1,   'MACD line', this.macdChart);
    this.macdSignalSeries = this._addLineSeries(COLORS.bear, 1, 'Signal line', this.macdChart);

    // Sync panes by *time*, not logical index: MACD series omit leading NaNs, so this chart
    // has fewer logical bars than the price chart — logical-range sync leaves MACD empty/wrong.
    this.chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (range) this.macdChart.timeScale().setVisibleRange(range);
    });

    // Resize
    this._resizeObs = new ResizeObserver(() => this._handleResize());
    this._resizeObs.observe(container);
    this._resizeObs.observe(macdEl);

    // Toggle controls
    document.getElementById('toggle-ema').addEventListener('change', (e) => {
      this.showEma = e.target.checked;
      this._toggleEma(this.showEma);
    });
    document.getElementById('toggle-volume').addEventListener('change', (e) => {
      this.showVolume = e.target.checked;
      this.volumeSeries.applyOptions({ visible: this.showVolume });
    });
    document.getElementById('toggle-supertrend').addEventListener('change', (e) => {
      this.showSupertrend = e.target.checked;
      this.stSeries.applyOptions({ visible: this.showSupertrend });
    });

    // TF tabs
    document.querySelectorAll('.tf-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentTf = btn.dataset.tf;
        this._loadTf(this.currentTf);
      });
    });
  }

  _addLineSeries(color, width, title, targetChart) {
    const c = targetChart ?? this.chart;
    return c.addLineSeries({
      color, lineWidth: width,
      priceScaleId: 'right',
      lastValueVisible: false, priceLineVisible: false,
      title,
    });
  }

  _toggleEma(show) {
    this.ema9Series.applyOptions({ visible: show });
    this.ema21Series.applyOptions({ visible: show });
    this.ema50Series.applyOptions({ visible: show });
  }

  _handleResize() {
    const c  = document.getElementById(this.containerId);
    const mc = document.getElementById(this.macdContainerId);
    if (c)  this.chart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
    if (mc) this.macdChart.applyOptions({ width: mc.clientWidth, height: mc.clientHeight });
  }

  /** Ingest snapshot (initial load) */
  onSnapshot({ candles, indicators }) {
    this.candleMap = candles ?? {};
    this.indicMap  = indicators ?? {};
    this._loadTf(this.currentTf);
  }

  /** Live kline update */
  onKline(tf, candle, _isFinal) {
    if (!this.candleMap[tf]) this.candleMap[tf] = [];
    const arr = this.candleMap[tf];
    const t = Math.floor(candle.openTime / 1000);
    const last = arr[arr.length - 1];
    if (last && last.openTime === candle.openTime) {
      arr[arr.length - 1] = candle;
    } else {
      arr.push(candle);
    }

    if (tf !== this.currentTf) return;

    const bar = { time: t, open: candle.open, high: candle.high, low: candle.low, close: candle.close };
    this.candleSeries.update(bar);

    this.volumeSeries.update({ time: t, value: candle.volume, color: candle.close >= candle.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)' });
  }

  onIndicators(indicators) {
    this.indicMap = { ...this.indicMap, ...indicators };
    this._paintIndicators(this.currentTf);
  }

  _loadTf(tf) {
    const candles = this.candleMap[tf];
    if (!candles || candles.length === 0) return;

    const bars = candles.map((c) => ({
      time: Math.floor(c.openTime / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const vols = candles.map((c) => ({
      time: Math.floor(c.openTime / 1000),
      value: c.volume,
      color: c.close >= c.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)',
    }));

    this.candleSeries.setData(bars);
    this.volumeSeries.setData(vols);

    this._paintIndicators(tf);
    this.chart.timeScale().fitContent();
  }

  _paintIndicators(tf) {
    const ind = this.indicMap[tf];
    if (!ind) return;

    const candles = this.candleMap[tf];
    if (!candles) return;
    const n = candles.length;

    /** Map indicator points to candle times (server sends same length as candles for 5m, or tail-aligned). */
    const candleTime = (idx) => Math.floor(candles[idx].openTime / 1000);

    const toLine = (arr) => {
      if (!arr || arr.length === 0) return [];
      const aligned =
        arr.length === n
          ? arr.map((v, i) => ({ v, i }))
          : arr.map((v, j) => ({ v, i: n - arr.length + j }));
      return aligned
        .map(({ v, i }) => {
          if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return null;
          if (i < 0 || i >= n) return null;
          return { time: candleTime(i), value: v };
        })
        .filter(Boolean);
    };

    if (ind.ema9) this.ema9Series.setData(toLine(ind.ema9));
    if (ind.ema21) this.ema21Series.setData(toLine(ind.ema21));
    if (ind.ema50) this.ema50Series.setData(toLine(ind.ema50));

    // Supertrend — dir/value aligned to same indices as candles when lengths match
    if (ind.supertrend?.value && ind.supertrend?.dir) {
      const vals = ind.supertrend.value;
      const dirs = ind.supertrend.dir;
      const stData = vals
        .map((v, j) => {
          if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return null;
          const i = vals.length === n ? j : n - vals.length + j;
          if (i < 0 || i >= n) return null;
          const col = dirs[j] === 'LONG' ? COLORS.bull : COLORS.bear;
          return { time: candleTime(i), value: v, color: col };
        })
        .filter(Boolean);
      this.stSeries.setData(stData);
    }

    // MACD — must share candle indices or the lower pane lags / leaves a blank gap on the right
    if (ind.macdHist) {
      const mh = ind.macdHist;
      const histData = mh
        .map((v, j) => {
          if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return null;
          const i = mh.length === n ? j : n - mh.length + j;
          if (i < 0 || i >= n) return null;
          const col = v >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,23,68,0.7)';
          return { time: candleTime(i), value: v, color: col };
        })
        .filter(Boolean);
      this.macdHistSeries.setData(histData);

      const lastHist = histData[histData.length - 1];
      if (lastHist) {
        const el = document.getElementById('macd-value-display');
        if (el) el.textContent = `${lastHist.value >= 0 ? '+' : ''}${lastHist.value.toFixed(4)}`;
      }
    }
    if (ind.macdLine) this.macdLineSeries.setData(toLine(ind.macdLine));
    if (ind.macdSignal) this.macdSignalSeries.setData(toLine(ind.macdSignal));

    const mainRange = this.chart.timeScale().getVisibleRange();
    if (mainRange) this.macdChart.timeScale().setVisibleRange(mainRange);
  }
}
