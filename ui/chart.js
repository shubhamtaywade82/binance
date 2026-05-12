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

/** Keep in sync with `CHART_BARS` in `src/dashboard/server.ts` (snapshot + indicator slice). */
const TF_MAX_BARS = {
  '5m': 300,
  '15m': 200,
  '1h': 100,
  '4h': 60,
  '1d': 30,
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
    /** @type {number | null} */
    this._macdAlignRaf = null;
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

    // MACD chart — horizontal scroll off so X-axis only follows the price chart (see time sync below).
    this.macdChart = LightweightCharts.createChart(macdEl, {
      ...CHART_OPTS,
      width: macdEl.clientWidth,
      height: macdEl.clientHeight,
      rightPriceScale: { ...CHART_OPTS.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.1 } },
      timeScale: { ...CHART_OPTS.timeScale, visible: false },
      handleScroll: false,
    });
    this.macdHistSeries = this.macdChart.addHistogramSeries({
      color: COLORS.accent, priceScaleId: 'right',
      lastValueVisible: false, priceLineVisible: false,
    });
    this.macdLineSeries   = this._addLineSeries(COLORS.ema9, 1,   'MACD line', this.macdChart);
    this.macdSignalSeries = this._addLineSeries(COLORS.bear, 1, 'Signal line', this.macdChart);

    // Keep MACD time axis locked to the price chart (pan/zoom fires logical and/or time range events).
    const syncMacd = (timeRangeFromEvent) => this._scheduleMacdTimeAlign(timeRangeFromEvent);
    this.chart.timeScale().subscribeVisibleTimeRangeChange((r) => syncMacd(r));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => syncMacd());

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

  /**
   * Extend line-like series to `lastTime` so the plot reaches the last candle (LW needs a point
   * at that time; we forward-fill the last value). Used for EMA / MACD lines / ST.
   */
  _padLineLikeToLastTime(points, lastTime) {
    if (!points?.length || !Number.isFinite(lastTime)) return points ?? [];
    const sorted = [...points].sort((a, b) => a.time - b.time);
    const last = sorted[sorted.length - 1];
    if (last.time >= lastTime) return sorted;
    return [...sorted, { ...last, time: lastTime }];
  }

  /**
   * Add zero-height histogram bars at candle opens after the last real MACD bar through the last
   * candle so the MACD pane shares the same time keys as the price chart (fixes horizontal gap).
   */
  _padMacdHistogramToLastCandle(histData, candleTime, n) {
    if (!histData?.length || n < 1) return histData ?? [];
    const sorted = [...histData].sort((a, b) => a.time - b.time);
    const tMaxHist = sorted[sorted.length - 1].time;
    const tEnd = candleTime(n - 1);
    if (tMaxHist >= tEnd) return sorted;
    const have = new Set(sorted.map((p) => p.time));
    const ghost = 'rgba(136,146,164,0.1)';
    const extra = [];
    for (let i = 0; i < n; i++) {
      const t = candleTime(i);
      if (t <= tMaxHist) continue;
      if (t > tEnd) break;
      if (!have.has(t)) extra.push({ time: t, value: 0, color: ghost });
    }
    return [...sorted, ...extra].sort((a, b) => a.time - b.time);
  }

  _clearOverlaySeries() {
    if (!this.ema9Series) return;
    this.ema9Series.setData([]);
    this.ema21Series.setData([]);
    this.ema50Series.setData([]);
    this.stSeries.setData([]);
    this.macdHistSeries.setData([]);
    this.macdLineSeries.setData([]);
    this.macdSignalSeries.setData([]);
  }

  /**
   * @param { { from?: unknown; to?: unknown } | null | undefined } [rangeFromEvent] Visible time range
   *   from `subscribeVisibleTimeRangeChange`, if any; otherwise we read `getVisibleRange()` after layout.
   */
  _scheduleMacdTimeAlign(rangeFromEvent) {
    if (this._macdAlignRaf != null) cancelAnimationFrame(this._macdAlignRaf);
    this._macdAlignRaf = requestAnimationFrame(() => {
      this._macdAlignRaf = null;
      if (!this.chart || !this.macdChart) return;
      const hasEventRange =
        rangeFromEvent &&
        rangeFromEvent.from != null &&
        rangeFromEvent.to != null;
      const range = hasEventRange ? rangeFromEvent : this.chart.timeScale().getVisibleRange();
      if (range && range.from != null && range.to != null) {
        try {
          this.macdChart.timeScale().setVisibleRange(range);
        } catch {
          this.macdChart.timeScale().fitContent();
        }
      } else {
        this.macdChart.timeScale().fitContent();
      }
      // Same visible time range is not enough: each chart derives barSpacing / rightOffset from its
      // own series, so the last candle and last MACD point can sit at different x positions.
      const mainTs = this.chart.timeScale().options();
      this.macdChart.timeScale().applyOptions({
        barSpacing: mainTs.barSpacing,
        rightOffset: mainTs.rightOffset,
        minBarSpacing: mainTs.minBarSpacing,
        fixLeftEdge: mainTs.fixLeftEdge,
        fixRightEdge: mainTs.fixRightEdge,
        rightBarStaysOnScroll: mainTs.rightBarStaysOnScroll,
      });
    });
  }

  _handleResize() {
    const c  = document.getElementById(this.containerId);
    const mc = document.getElementById(this.macdContainerId);
    if (c)  this.chart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
    if (mc) this.macdChart.applyOptions({ width: mc.clientWidth, height: mc.clientHeight });
    this._scheduleMacdTimeAlign();
  }

  /**
   * Canonical candle list: ascending openTime, one row per openTime (last wins).
   * Mirrors server `MultiTimeframeStore.seed` so Lightweight Charts always gets sorted data.
   */
  _sortedDedupeCandles(candles) {
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    const out = [];
    let prevT = -Infinity;
    for (const c of sorted) {
      const t = Number(c.openTime);
      if (!Number.isFinite(t)) continue;
      const row = { ...c, openTime: t };
      if (t === prevT) out[out.length - 1] = row;
      else {
        out.push(row);
        prevT = t;
      }
    }
    return out;
  }

  _applyTimeScaleForTf(tf) {
    const dailyLike = tf === '1d';
    const ts = {
      ...CHART_OPTS.timeScale,
      timeVisible: !dailyLike,
      secondsVisible: false,
    };
    this.chart.applyOptions({ timeScale: ts });
    this.macdChart.applyOptions({ timeScale: { ...ts, visible: false } });
  }

  /** Ingest snapshot (initial load) */
  onSnapshot({ candles, indicators }) {
    this.candleMap = candles ?? {};
    this.indicMap  = indicators ?? {};
    this._loadTf(this.currentTf);
  }

  /** Live kline update — keep `candleMap` consistent with server store (order, dedupe, cap). */
  onKline(tf, candle, _isFinal) {
    if (!this.candleMap[tf]) this.candleMap[tf] = [];
    const arr = this.candleMap[tf];
    const cap = TF_MAX_BARS[tf];
    const ot = Number(candle.openTime);
    if (!Number.isFinite(ot)) return;
    const row = { ...candle, openTime: ot };

    if (arr.length === 0) {
      arr.push(row);
    } else {
      const last = arr[arr.length - 1];
      if (row.openTime === last.openTime) {
        arr[arr.length - 1] = row;
      } else if (row.openTime > last.openTime) {
        arr.push(row);
      } else {
        const idx = arr.findIndex((c) => c.openTime === row.openTime);
        if (idx >= 0) arr[idx] = row;
        else {
          arr.push(row);
          arr.sort((a, b) => a.openTime - b.openTime);
        }
      }
    }
    if (cap != null && arr.length > cap) arr.splice(0, arr.length - cap);

    if (tf !== this.currentTf) return;

    const t = Math.floor(row.openTime / 1000);
    if (!Number.isFinite(t)) return;
    const bar = { time: t, open: row.open, high: row.high, low: row.low, close: row.close };
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) return;
    this.candleSeries.update(bar);

    this.volumeSeries.update({
      time: t,
      value: row.volume,
      color: row.close >= row.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)',
    });
  }

  onIndicators(indicators) {
    this.indicMap = { ...this.indicMap, ...indicators };
    this._paintIndicators(this.currentTf);
  }

  _loadTf(tf) {
    const raw = this.candleMap[tf];
    this._applyTimeScaleForTf(tf);

    if (!raw || raw.length === 0) {
      this.candleSeries.setData([]);
      this.volumeSeries.setData([]);
      this._clearOverlaySeries();
      this.chart.timeScale().fitContent();
      return;
    }

    const candles = this._sortedDedupeCandles(raw);

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
    const raw = this.candleMap[tf];
    if (!raw || raw.length === 0) {
      this._clearOverlaySeries();
      return;
    }

    const candles = this._sortedDedupeCandles(raw);
    const ind = this.indicMap[tf];
    if (!ind) {
      this._clearOverlaySeries();
      return;
    }

    this._applyTimeScaleForTf(tf);

    const n = candles.length;

    /** Map indicator points to candle times (server sends same length as candles for 5m, or tail-aligned). */
    const candleTime = (idx) => Math.floor(candles[idx].openTime / 1000);
    const tLastCandle = candleTime(n - 1);

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

    if (ind.ema9) this.ema9Series.setData(this._padLineLikeToLastTime(toLine(ind.ema9), tLastCandle));
    if (ind.ema21) this.ema21Series.setData(this._padLineLikeToLastTime(toLine(ind.ema21), tLastCandle));
    if (ind.ema50) this.ema50Series.setData(this._padLineLikeToLastTime(toLine(ind.ema50), tLastCandle));

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
      const stPadded = this._padLineLikeToLastTime(stData, tLastCandle);
      this.stSeries.setData(stPadded);
    }

    // MACD — must share candle indices or the lower pane lags / leaves a blank gap on the right
    if (ind.macdHist) {
      const mh = ind.macdHist;
      const histRaw = mh
        .map((v, j) => {
          if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return null;
          const i = mh.length === n ? j : n - mh.length + j;
          if (i < 0 || i >= n) return null;
          const col = v >= 0 ? 'rgba(0,230,118,0.7)' : 'rgba(255,23,68,0.7)';
          return { time: candleTime(i), value: v, color: col };
        })
        .filter(Boolean);
      const histSorted = [...histRaw].sort((a, b) => a.time - b.time);
      const histData = this._padMacdHistogramToLastCandle(histSorted, candleTime, n);
      this.macdHistSeries.setData(histData);

      const lastHist = histSorted[histSorted.length - 1];
      if (lastHist) {
        const el = document.getElementById('macd-value-display');
        if (el) el.textContent = `${lastHist.value >= 0 ? '+' : ''}${lastHist.value.toFixed(4)}`;
      }
    }
    if (ind.macdLine) {
      this.macdLineSeries.setData(this._padLineLikeToLastTime(toLine(ind.macdLine), tLastCandle));
    }
    if (ind.macdSignal) {
      this.macdSignalSeries.setData(this._padLineLikeToLastTime(toLine(ind.macdSignal), tLastCandle));
    }

    this._scheduleMacdTimeAlign();
  }
}
