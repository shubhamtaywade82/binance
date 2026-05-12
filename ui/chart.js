/**
 * chart.js — TradingView Lightweight Charts integration
 * Handles: candlestick, volume, EMA 9/21/50, supertrend
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
  handleScale: { mouseWheel: true, pinch: true },
};

/** Match `MAX_STORE_BARS` in `src/dashboard/server.ts` — trim client cache same as server. */
const MAX_STORE_BARS = 100_000;
/** When the left edge of the visible window is within this many bars of the oldest loaded bar, request older history. */
const LAZY_HISTORY_EDGE_BARS = 24;
const LAZY_HISTORY_DEBOUNCE_MS = 400;

/**
 * Default visible bar count per TF (most recent bars only).
 * `fitContent()` on the full 1500×5m seed (~5d) pins the left edge to the dataset start, so EMA
 * warm up from too little history and look wildly wrong vs TradingView (which keeps deep history
 * left of the viewport). Showing the tail matches typical TV zoom and stabilizes overlays.
 */
const DEFAULT_VISIBLE_BARS = {
  '5m': 220, // ~18h 20m
  '15m': 160, // ~40h
  '1h': 120, // ~5d
  '4h': 90, // ~15d
  '1d': 120, // ~4mo
};

export class ChartManager {
  constructor(containerId) {
    this.containerId = containerId;
    this.chart = null;
    this.candleSeries = null;
    this.volumeSeries = null;
    this.ema9Series = null;
    this.ema21Series = null;
    this.ema50Series = null;
    this.stSeries = null;
    this.currentTf = '5m';
    this.candleMap = {}; // tf → candle[] cache
    this.indicMap = {}; // tf → indicators cache
    this.showEma = true;
    this.showVolume = true;
    this.showSupertrend = true;
    this._resizeObs = null;
    /** @type {Record<string, boolean>} */
    this._historyExhausted = {};
    /** @type {Record<string, boolean>} */
    this._historyLoading = {};
    /** @type {number | null} */
    this._historyDebounceTimer = null;
    /** @type {((p: { tf: string; oldestOpenTime: number }) => void) | null} */
    this._onNeedHistory = null;
  }

  /**
   * @param {(p: { tf: string; oldestOpenTime: number }) => void} fn
   */
  setHistoryRequestHandler(fn) {
    this._onNeedHistory = fn;
  }

  getCurrentTf() {
    return this.currentTf;
  }

  /** Last close for `tf` after the same merge/dedupe used for candles (source of truth for LTP vs chart). */
  getLastCloseForTf(tf) {
    const raw = this.candleMap[tf];
    if (!raw?.length) return null;
    const candles = this._sortedDedupeCandles(raw);
    const last = candles[candles.length - 1];
    const c = Number(last?.close);
    return Number.isFinite(c) ? c : null;
  }

  init() {
    const container = document.getElementById(this.containerId);

    this.chart = LightweightCharts.createChart(container, {
      ...CHART_OPTS,
      width: container.clientWidth,
      height: container.clientHeight,
    });

    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: COLORS.bull,
      downColor: COLORS.bear,
      borderUpColor: COLORS.bull,
      borderDownColor: COLORS.bear,
      wickUpColor: COLORS.bull,
      wickDownColor: COLORS.bear,
    });

    this.volumeSeries = this.chart.addHistogramSeries({
      color: COLORS.bull,
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      scaleMargins: { top: 0.75, bottom: 0 },
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

    this.ema9Series = this._addLineSeries(COLORS.ema9, 1, 'EMA9');
    this.ema21Series = this._addLineSeries(COLORS.ema21, 1, 'EMA21');
    this.ema50Series = this._addLineSeries(COLORS.ema50, 1.5, 'EMA50');

    this.stSeries = this.chart.addLineSeries({
      color: COLORS.bull,
      lineWidth: 1.5,
      lineStyle: 2,
      priceScaleId: 'right',
      lastValueVisible: false,
      priceLineVisible: false,
    });

    this.chart.timeScale().subscribeVisibleLogicalRangeChange((lr) => {
      this._maybeRequestHistory(lr);
    });

    this._resizeObs = new ResizeObserver(() => this._handleResize());
    this._resizeObs.observe(container);

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

    document.querySelectorAll('.tf-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (this._historyDebounceTimer != null) {
          clearTimeout(this._historyDebounceTimer);
          this._historyDebounceTimer = null;
        }
        this.currentTf = btn.dataset.tf;
        this._loadTf(this.currentTf);
      });
    });
  }

  _addLineSeries(color, width, title, targetChart) {
    const c = targetChart ?? this.chart;
    return c.addLineSeries({
      color,
      lineWidth: width,
      priceScaleId: 'right',
      lastValueVisible: false,
      priceLineVisible: false,
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
   * at that time; we forward-fill the last value). Used for EMA / supertrend.
   */
  _padLineLikeToLastTime(points, lastTime) {
    if (!points?.length || !Number.isFinite(lastTime)) return points ?? [];
    const sorted = [...points].sort((a, b) => a.time - b.time);
    const last = sorted[sorted.length - 1];
    if (last.time >= lastTime) return sorted;
    return [...sorted, { ...last, time: lastTime }];
  }

  _clearOverlaySeries() {
    if (!this.ema9Series) return;
    this.ema9Series.setData([]);
    this.ema21Series.setData([]);
    this.ema50Series.setData([]);
    this.stSeries.setData([]);
  }

  _maybeRequestHistory(logicalRange) {
    if (!this._onNeedHistory || !logicalRange) return;
    const from = logicalRange.from;
    if (from == null || !Number.isFinite(from)) return;
    const tf = this.currentTf;
    if (this._historyExhausted[tf] || this._historyLoading[tf]) return;
    if (from > LAZY_HISTORY_EDGE_BARS) return;

    const raw = this.candleMap[tf];
    if (!raw?.length) return;
    const sorted = this._sortedDedupeCandles(raw);
    if (!sorted.length) return;
    const oldestOpenTime = sorted[0].openTime;

    if (this._historyDebounceTimer != null) clearTimeout(this._historyDebounceTimer);
    this._historyDebounceTimer = setTimeout(() => {
      this._historyDebounceTimer = null;
      if (this._historyExhausted[tf] || this._historyLoading[tf]) return;
      this._historyLoading[tf] = true;
      this._onNeedHistory({ tf, oldestOpenTime });
    }, LAZY_HISTORY_DEBOUNCE_MS);
  }

  onHistoryChunk(tf, olderCandles) {
    if (!olderCandles?.length) {
      this._historyLoading[tf] = false;
      return;
    }
    const existing = this.candleMap[tf] ?? [];
    const beforeLen = this._sortedDedupeCandles(existing).length;
    let logicalBefore = null;
    if (tf === this.currentTf && this.chart) {
      logicalBefore = this.chart.timeScale().getVisibleLogicalRange();
    }
    const merged = this._sortedDedupeCandles([...olderCandles, ...existing]);
    const trimmed = merged.length > MAX_STORE_BARS ? merged.slice(-MAX_STORE_BARS) : merged;
    this.candleMap[tf] = trimmed;
    this._historyLoading[tf] = false;

    if (tf !== this.currentTf) return;

    const afterLen = trimmed.length;
    const delta = afterLen - beforeLen;
    const candles = trimmed;
    const bars = candles.map((c) => ({
      time: Math.floor(c.openTime / 1000),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const vols = candles.map((c) => ({
      time: Math.floor(c.openTime / 1000),
      value: c.volume,
      color: c.close >= c.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)',
    }));
    this.candleSeries.setData(bars);
    this.volumeSeries.setData(vols);
    this._paintIndicators(tf);
    if (
      delta > 0 &&
      logicalBefore &&
      logicalBefore.from != null &&
      logicalBefore.to != null &&
      Number.isFinite(logicalBefore.from) &&
      Number.isFinite(logicalBefore.to)
    ) {
      try {
        this.chart.timeScale().setVisibleLogicalRange({
          from: logicalBefore.from + delta,
          to: logicalBefore.to + delta,
        });
      } catch {
        /* ignore */
      }
    }
  }

  onHistoryEnd(tf) {
    this._historyExhausted[tf] = true;
    this._historyLoading[tf] = false;
  }

  onHistoryError(tf) {
    this._historyLoading[tf] = false;
  }

  onHistoryBusy(tf) {
    this._historyLoading[tf] = false;
  }

  _handleResize() {
    const c = document.getElementById(this.containerId);
    if (c) this.chart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
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
      const row = {
        ...c,
        openTime: t,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      };
      if (![row.open, row.high, row.low, row.close].every(Number.isFinite)) continue;
      if (!Number.isFinite(row.volume)) row.volume = 0;
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
      rightOffset: 10,
      fixLeftEdge: false,
      fixRightEdge: false,
      rightBarStaysOnScroll: true,
    };
    this.chart.applyOptions({ timeScale: ts });
  }

  /**
   * Zoom to the latest candles so indicator warm-up uses bars to the left of the viewport
   * (Binance/TradingView-style), instead of stretching the entire seed with the oldest bar on the left.
   */
  _fitDefaultVisibleRange(tf, barCount) {
    if (!this.chart || barCount < 1) return;
    const want = DEFAULT_VISIBLE_BARS[tf] ?? 160;
    if (barCount <= want) {
      this.chart.timeScale().fitContent();
    } else {
      const from = barCount - want;
      const to = barCount - 1;
      try {
        this.chart.timeScale().setVisibleLogicalRange({ from, to });
      } catch {
        this.chart.timeScale().fitContent();
      }
    }
  }

  /** Ingest snapshot (initial load) */
  onSnapshot({ candles, indicators }) {
    this._historyExhausted = {};
    this._historyLoading = {};
    this.candleMap = candles ?? {};
    this.indicMap = indicators ?? {};
    this._loadTf(this.currentTf);
  }

  /** Live kline update — keep `candleMap` consistent with server store (order, dedupe, cap). */
  onKline(tf, candle, _isFinal) {
    if (!this.candleMap[tf]) this.candleMap[tf] = [];
    const arr = this.candleMap[tf];
    const ot = Number(candle.openTime);
    if (!Number.isFinite(ot)) return;
    const row = {
      ...candle,
      openTime: ot,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
    };

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
    if (arr.length > MAX_STORE_BARS) arr.splice(0, arr.length - MAX_STORE_BARS);

    if (tf !== this.currentTf) return;

    const sorted = this._sortedDedupeCandles(arr);
    const tail = sorted[sorted.length - 1];
    /** `update()` only matches LW semantics for the latest bar; any other edit needs full setData. */
    if (!tail || tail.openTime !== row.openTime) {
      this._loadTf(tf);
      return;
    }

    const t = Math.floor(row.openTime / 1000);
    if (!Number.isFinite(t)) return;
    const bar = { time: t, open: row.open, high: row.high, low: row.low, close: row.close };
    if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) return;
    const vol = Number.isFinite(row.volume) ? row.volume : 0;
    try {
      this.candleSeries.update(bar);
      this.volumeSeries.update({
        time: t,
        value: vol,
        color: row.close >= row.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)',
      });
    } catch (e) {
      console.warn('[chart] candle update failed, resyncing series', e);
      this._loadTf(tf);
    }
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
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    const vols = candles.map((c) => ({
      time: Math.floor(c.openTime / 1000),
      value: c.volume,
      color: c.close >= c.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)',
    }));

    this.candleSeries.setData(bars);
    this.volumeSeries.setData(vols);

    this._paintIndicators(tf);
    this._fitDefaultVisibleRange(tf, candles.length);
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

    const candleTime = (idx) => Math.floor(candles[idx].openTime / 1000);
    const tLastCandle = candleTime(n - 1);

    const toLine = (arr) => {
      if (!arr || arr.length === 0) return [];
      const aligned =
        arr.length === n ? arr.map((v, i) => ({ v, i })) : arr.map((v, j) => ({ v, i: n - arr.length + j }));
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
  }
}
