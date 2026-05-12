/**
 * chart.js — TradingView Lightweight Charts integration
 * Handles: candlestick, volume, EMA 9/21/50, supertrend
 */
import { createChart, LineStyle } from 'lightweight-charts';
import { ltpPriceFromTicks, ltpTicksFromPrice } from './ltp-precision.js';

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
    /** Stops ultra-dense zoom where LW merges wicks/bodies and candles look like flat hash marks. */
    minBarSpacing: 2,
  },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
  handleScale: { mouseWheel: true, pinch: true },
};

/** Match `DASHBOARD_STORE_MAX_BARS` / `src/dashboard/bridge.ts` — trim client cache same as server. */
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
  '1m': 300, // ~5h
  '5m': 220, // ~18h 20m
  '15m': 160, // ~40h
  '1h': 120, // ~5d
  '4h': 90, // ~15d
  '1d': 120, // ~4mo
};

/** Tab order when picking a default TF (must match `.tf-btn` data-tf). */
const TF_TAB_ORDER = ['1m', '5m', '15m', '1h', '4h', '1d'];

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
    /** Custom dashed LTP line (series default price line jumps on each tick). */
    this._ltpPriceLine = null;
    /** Integer price × 1_000 — sequential steps ±1 toward `_ltpTargetTicks`. */
    this._ltpDisplayTicks = null;
    /** @type {number | null} */
    this._ltpTargetTicks = null;
    /** @type {number | null} */
    this._ltpRafId = null;
    /** @type {((tf: string) => void) | null} */
    this._onTfChange = null;
    /** @type {Set<string> | null} */
    this._availableTfSet = null;
    /** @type {((price: number | null) => void) | null} */
    this._ltpDisplayListener = null;
    /** Server truth for the in-progress bar (chart close follows `_ltpDisplayTicks`). */
    this._formingBarCtx = null;
  }

  /** @param {(tf: string) => void} fn */
  setTfChangeHandler(fn) {
    this._onTfChange = fn;
  }

  /** Optional: sync header / UI with the smoothed LTP value each animation frame. */
  setLtpDisplayListener(fn) {
    this._ltpDisplayListener = fn;
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

  _applyAvailableTimeframes(list) {
    const wrap = document.getElementById('tf-tabs');
    if (!wrap) return;
    const buttons = wrap.querySelectorAll('.tf-btn');
    if (!Array.isArray(list) || list.length === 0) {
      this._availableTfSet = null;
      buttons.forEach((b) => {
        b.style.display = '';
        b.disabled = false;
      });
      return;
    }
    this._availableTfSet = new Set(list.map((t) => String(t).trim().toLowerCase()));
    buttons.forEach((b) => {
      const tf = b.dataset.tf;
      const ok = this._availableTfSet.has(tf);
      b.style.display = ok ? '' : 'none';
      b.disabled = !ok;
    });
  }

  _pickFirstAvailableTf() {
    if (!this._availableTfSet) return this.currentTf;
    for (const t of TF_TAB_ORDER) {
      if (this._availableTfSet.has(t)) return t;
    }
    const [first] = this._availableTfSet;
    return first ?? this.currentTf;
  }

  _emitLtpDisplay(price) {
    try {
      this._ltpDisplayListener?.(price);
    } catch (e) {
      console.warn('[chart] ltp display listener', e);
    }
  }

  _cancelLtpAnim() {
    if (this._ltpRafId != null) {
      cancelAnimationFrame(this._ltpRafId);
      this._ltpRafId = null;
    }
  }

  _hideLtpPriceLine() {
    this._cancelLtpAnim();
    this._ltpTargetTicks = null;
    this._ltpDisplayTicks = null;
    this._formingBarCtx = null;
    if (this._ltpPriceLine && this.candleSeries) {
      try {
        this.candleSeries.removePriceLine(this._ltpPriceLine);
      } catch {
        /* ignore */
      }
    }
    this._ltpPriceLine = null;
  }

  /** @param {object | null} tail coerced candle (openTime, OHLC, volume). */
  _setFormingBarCtxFromQuote(tail) {
    if (!tail) {
      this._formingBarCtx = null;
      return;
    }
    const t = Math.floor(tail.openTime / 1000);
    if (!Number.isFinite(t)) {
      this._formingBarCtx = null;
      return;
    }
    this._formingBarCtx = {
      time: t,
      open: tail.open,
      high: tail.high,
      low: tail.low,
      closeTruth: tail.close,
      volume: tail.volume,
      openTime: tail.openTime,
    };
  }

  _refreshFormingCandleFromCtx() {
    const ctx = this._formingBarCtx;
    if (!ctx || !this.candleSeries) return;
    const dispTicks = this._ltpDisplayTicks;
    if (dispTicks == null || !Number.isFinite(dispTicks)) return;
    const truthTicks = ltpTicksFromPrice(ctx.closeTruth);
    const dispClose = ltpPriceFromTicks(dispTicks);
    const { time, open, high: hTrue, low: lTrue, closeTruth } = ctx;
    if (![time, open, hTrue, lTrue, closeTruth].every(Number.isFinite)) return;

    const bar =
      dispTicks === truthTicks
        ? { time, open, high: hTrue, low: lTrue, close: closeTruth }
        : {
            time,
            open,
            high: Math.max(open, hTrue, dispClose),
            low: Math.min(open, lTrue, dispClose),
            close: dispClose,
          };
    try {
      this.candleSeries.update(bar);
    } catch (e) {
      console.warn('[chart] forming candle update failed, resyncing series', e);
      this._formingBarCtx = null;
      this._loadTf(this.currentTf);
    }
  }

  _ensureLtpPriceLine(initialPrice) {
    if (this._ltpPriceLine != null || !this.candleSeries) return;
    this._ltpPriceLine = this.candleSeries.createPriceLine({
      price: initialPrice,
      color: COLORS.bear,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: true,
      axisLabelVisible: true,
      axisLabelColor: COLORS.bear,
    });
  }

  _ltpAnimStep() {
    this._ltpRafId = null;
    if (
      this._ltpPriceLine == null ||
      this._ltpDisplayTicks == null ||
      this._ltpTargetTicks == null ||
      !Number.isFinite(this._ltpTargetTicks)
    ) {
      return;
    }
    if (this._ltpDisplayTicks === this._ltpTargetTicks) {
      this._refreshFormingCandleFromCtx();
      return;
    }
    this._ltpDisplayTicks += this._ltpDisplayTicks < this._ltpTargetTicks ? 1 : -1;
    const p = ltpPriceFromTicks(this._ltpDisplayTicks);
    this._ltpPriceLine.applyOptions({ price: p });
    this._emitLtpDisplay(p);
    this._refreshFormingCandleFromCtx();
    if (this._ltpDisplayTicks !== this._ltpTargetTicks) {
      this._ltpRafId = requestAnimationFrame(() => this._ltpAnimStep());
    }
  }

  _snapLtpTo(price) {
    if (!Number.isFinite(price)) {
      this._hideLtpPriceLine();
      this._emitLtpDisplay(null);
      return;
    }
    this._cancelLtpAnim();
    const ticks = ltpTicksFromPrice(price);
    this._ltpTargetTicks = ticks;
    this._ltpDisplayTicks = ticks;
    const p = ltpPriceFromTicks(ticks);
    this._ensureLtpPriceLine(p);
    this._ltpPriceLine.applyOptions({
      price: p,
      lineVisible: true,
      axisLabelVisible: true,
      color: COLORS.bear,
      axisLabelColor: COLORS.bear,
    });
    this._emitLtpDisplay(p);
    this._refreshFormingCandleFromCtx();
  }

  _smoothLtpTo(price) {
    if (!Number.isFinite(price)) {
      this._hideLtpPriceLine();
      this._emitLtpDisplay(null);
      return;
    }
    const targetTicks = ltpTicksFromPrice(price);
    this._ltpTargetTicks = targetTicks;
    const startP = ltpPriceFromTicks(this._ltpDisplayTicks ?? targetTicks);
    this._ensureLtpPriceLine(startP);
    if (this._ltpDisplayTicks == null || !Number.isFinite(this._ltpDisplayTicks)) {
      this._snapLtpTo(price);
      return;
    }
    if (this._ltpDisplayTicks === this._ltpTargetTicks) {
      const p = ltpPriceFromTicks(this._ltpDisplayTicks);
      this._ensureLtpPriceLine(p);
      this._ltpPriceLine.applyOptions({ price: p });
      this._emitLtpDisplay(p);
      this._refreshFormingCandleFromCtx();
      return;
    }
    if (this._ltpRafId == null) {
      this._ltpRafId = requestAnimationFrame(() => this._ltpAnimStep());
    }
    this._refreshFormingCandleFromCtx();
  }

  init() {
    const container = document.getElementById(this.containerId);

    this.chart = createChart(container, {
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
      borderVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
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
        this._onTfChange?.(this.currentTf);
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
      } catch (e) {
        console.warn('[chart] setVisibleLogicalRange after history', e);
      }
    }
    const rawClose = candles[candles.length - 1]?.close;
    this._setFormingBarCtxFromQuote(candles[candles.length - 1] ?? null);
    this._snapLtpTo(Number.isFinite(rawClose) ? rawClose : NaN);
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
   * Valid OHLC + wick clamp (Binance partials can briefly violate h≥l). Returns null if unusable.
   */
  _coerceCandle(c) {
    const t = Number(c.openTime);
    const o = Number(c.open);
    const h0 = Number(c.high);
    const l0 = Number(c.low);
    const cl = Number(c.close);
    const v = Number(c.volume);
    if (![t, o, h0, l0, cl].every(Number.isFinite)) return null;
    const hi = Math.max(o, cl, h0, l0);
    const lo = Math.min(o, cl, h0, l0);
    return {
      ...c,
      openTime: t,
      open: o,
      high: hi,
      low: lo,
      close: cl,
      volume: Number.isFinite(v) ? v : 0,
    };
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
      const row = this._coerceCandle(c);
      if (!row) continue;
      const t = row.openTime;
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
  onSnapshot({ candles, indicators, availableTimeframes }) {
    this._historyExhausted = {};
    this._historyLoading = {};
    this._applyAvailableTimeframes(availableTimeframes ?? null);

    const raw = candles ?? {};
    this.candleMap = {};
    for (const [k, v] of Object.entries(raw)) {
      this.candleMap[k] = Array.isArray(v) ? this._sortedDedupeCandles(v) : v;
    }
    this.indicMap = indicators ?? {};

    if (this._availableTfSet && !this._availableTfSet.has(this.currentTf)) {
      const next = this._pickFirstAvailableTf();
      this.currentTf = next;
      document.querySelectorAll('.tf-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.tf === next);
      });
    }

    this._loadTf(this.currentTf);
  }

  /** Live kline update — keep `candleMap` consistent with server store (order, dedupe, cap). */
  onKline(tf, candle, _isFinal) {
    if (!this.candleMap[tf]) this.candleMap[tf] = [];
    const arr = this.candleMap[tf];
    const prevSorted = this._sortedDedupeCandles(arr);
    const prevLastOpenTime =
      prevSorted.length > 0 ? prevSorted[prevSorted.length - 1].openTime : null;

    const row = this._coerceCandle(candle);
    if (!row) return;

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

    const canon = this._sortedDedupeCandles(arr);
    arr.length = 0;
    arr.push(...canon);

    if (tf !== this.currentTf) return;

    if (!canon.some((c) => c.openTime === row.openTime)) return;

    const tail = canon[canon.length - 1];
    /** `update()` only matches LW semantics for the latest bar; any other edit needs full setData. */
    if (!tail || tail.openTime !== row.openTime) {
      this._loadTf(tf);
      return;
    }

    const t = Math.floor(tail.openTime / 1000);
    if (!Number.isFinite(t)) return;
    if (![tail.open, tail.high, tail.low, tail.close].every(Number.isFinite)) return;
    const vol = tail.volume;
    this._setFormingBarCtxFromQuote(tail);
    try {
      this.volumeSeries.update({
        time: t,
        value: vol,
        color: tail.close >= tail.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)',
      });
      const sameBar = prevLastOpenTime != null && tail.openTime === prevLastOpenTime;
      if (sameBar) this._smoothLtpTo(tail.close);
      else this._snapLtpTo(tail.close);
      this._refreshFormingCandleFromCtx();
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
      this._hideLtpPriceLine();
      this._emitLtpDisplay(null);
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
    this._setFormingBarCtxFromQuote(candles[candles.length - 1] ?? null);
    const lastClose = candles[candles.length - 1]?.close;
    this._snapLtpTo(Number.isFinite(lastClose) ? lastClose : NaN);
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
