/**
 * chart.js — TradingView Lightweight Charts integration
 * Handles: candlestick, volume, EMA 9/21/50, supertrend
 *
 * Browser persistence (localStorage, same tab origin):
 * - `qt_chart_tf` — last chart timeframe (1m … 1d)
 * - `qt_chart_show_ema` / `qt_chart_show_supertrend` — overlay toggles (`1` / `0`)
 * - Book top, SMC overlay, signal HUD (and HUD detail drawer), candle theme use their own keys (see respective modules / below)
 */
import { createChart, LineStyle } from 'lightweight-charts';
import {
  CANDLE_THEMES,
  getCandleTheme,
  getHistogramBarColors,
  readStoredCandleThemeId,
  storeCandleThemeId,
} from './candle-themes.js';
import {
  getMinTickDecimalPlaces,
  ltpPriceFromTicks,
  ltpTicksFromPrice,
  setLtpDecimalPlacesFromServer,
  setMinTickDecimalPlacesFromServer,
} from './ltp-precision.js';
import {
  readSignalHudEnabled,
  renderStrategyHud,
  storeSignalHudDetailsOpen,
  storeSignalHudEnabled,
} from './chart-strategy-hud.js';
import { SmcZoneBoxesPrimitive } from './chart-smc-zone-primitive.js';
import { PartialPriceLinesPrimitive } from './chart-partial-price-lines.js';

const BOOK_TOP_STORAGE_KEY = 'qt_chart_book_top';

const readBookTopLinesEnabled = () => {
  try {
    return localStorage.getItem(BOOK_TOP_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

const storeBookTopLinesEnabled = (on) => {
  try {
    localStorage.setItem(BOOK_TOP_STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore */
  }
}

const COLORS = {
  bull: '#00e676',
  bear: '#ff1744',
  /** Colorblind-safe bull for LTP / price lines (cyan-teal, distinguishable from bear red). */
  ltpBull: '#00c8dc',
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
    alignLabels: true,
    entireTextOnly: true,
  },
  timeScale: {
    borderColor: 'rgba(255,255,255,0.06)',
    timeVisible: true,
    secondsVisible: false,
    /** LW default 0.5; keep a small floor so extreme zoom stays readable (was 2 for wider minimum gap). */
    minBarSpacing: 1,
  },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
  handleScale: { mouseWheel: true, pinch: true },
};

/** Match `DASHBOARD_STORE_MAX_BARS` / `src/dashboard/bridge.ts` — trim client cache same as server. */
const MAX_STORE_BARS = 100_000;

/** Proportional smoothing for current price line (0.01 = extremely slow/smooth, 1.0 = instant snap). */
const LTP_SMOOTHING = Number.parseFloat(import.meta.env?.VITE_CHART_LTP_SMOOTHING ?? '0.1');
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

const SMC_OVERLAY_STORAGE_KEY = 'qt_smc_chart_overlay';
const KNN_ARCHITECTURE_STORAGE_KEY = 'qt_knn_chart_overlay';
const LIQUIDATION_MARKERS_STORAGE_KEY = 'qt_chart_liquidations';
const OI_REGIME_STORAGE_KEY = 'qt_chart_oi_regime';
const VWAP_STORAGE_KEY = 'qt_chart_vwap';
const RSI_STORAGE_KEY = 'qt_chart_rsi';
const SPREAD_HEATMAP_STORAGE_KEY = 'qt_chart_spread_heatmap';
const TFI_STORAGE_KEY = 'qt_chart_tfi';
const DEPTH_PRESSURE_STORAGE_KEY = 'qt_chart_depth_pressure';
const OBI_TINT_STORAGE_KEY = 'qt_chart_obi_tint';
const MICRO_CHART_STORAGE_KEY = 'qt_chart_micro';

/** Persisted chart timeframe (must match `.tf-btn` data-tf). */
const CHART_TF_STORAGE_KEY = 'qt_chart_tf';
const CHART_SHOW_EMA_STORAGE_KEY = 'qt_chart_show_ema';
const CHART_SHOW_ST_STORAGE_KEY = 'qt_chart_show_supertrend';

const readStoredChartTf = () => {
  try {
    const raw = localStorage.getItem(CHART_TF_STORAGE_KEY)?.trim().toLowerCase();
    if (raw && TF_TAB_ORDER.includes(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
};

const storeChartTf = (tf) => {
  try {
    if (tf && TF_TAB_ORDER.includes(tf)) localStorage.setItem(CHART_TF_STORAGE_KEY, tf);
  } catch {
    /* ignore */
  }
};


const readStoredIndicatorOn = (key, defaultOn = true) => {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultOn;
    return v !== '0';
  } catch {
    return defaultOn;
  }
};

const storeIndicatorOn = (key, on) => {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    /* ignore */
  }
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
    this.currentTf = readStoredChartTf() ?? '5m';
    this.candleMap = {}; // tf → candle[] cache
    this.indicMap = {}; // tf → indicators cache
    this._resizeObs = null;
    /** @type {Record<string, boolean>} */
    this._historyExhausted = {};
    /** @type {Record<string, boolean>} */
    this._historyLoading = {};
    /** @type {number | null} */
    this._historyDebounceTimer = null;
    /** @type {((p: { tf: string; oldestOpenTime: number }) => void) | null} */
    this._onNeedHistory = null;
    /** Invisible price line for axis label; visual line drawn by `_partialLinesPrimitive`. */
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
    /** Histogram bar colors (from candle theme). */
    this._volumeColorUp = '';
    this._volumeColorDown = '';
    /** Smoothed volume for the in-progress bar (monotonic toward exchange total). */
    this._volDisplay = null;
    this._volTarget = null;
    this._volAnimBarTime = null;
    this._volAnimColor = '';
    /** @type {number | null} */
    this._volRafId = null;
    /** Best bid / ask from order book. */
    this._lastBookBid = null;
    this._lastBookAsk = null;
    this._bookTopLinesEnabled = readBookTopLinesEnabled();
    /** 24h high/low values from ticker. */
    this._lastHigh24h = null;
    this._lastLow24h = null;
    /** Single canvas primitive for all partial horizontal price lines (LTP, BID, ASK, 24h H/L). */
    this._partialLinesPrimitive = null;
    /** @type {(() => void) | null} */
    this._candleThemeDocCloseUnsub = null;
    /** Horizontal SMC / ref levels (not the LTP line). */
    this._smcSignalPriceLines = [];
    /** SMC markers (separate from liquidation markers, merged via _paintAllMarkers). */
    this._lastSmcMarkers = [];
    /** Open-position markers and entry lines. */
    this._positionMarkers = [];
    this._openPositionLines = new Map();
    /** Shaded OB / FVG zones (LWC series primitive). */
    this._smcZonePrimitive = null;
    this._smcSignalsOverlayEnabled = this._readSmcOverlayEnabled();
    this._knnArchitectureEnabled = this._readKnnArchitectureEnabled();
    /** Latest WS `signals` payload for redraw after `setData`. */
    this._lastSignalsForChart = null;
    this._signalHudEnabled = readSignalHudEnabled();
    this.showEma = readStoredIndicatorOn(CHART_SHOW_EMA_STORAGE_KEY, true);
    this.showSupertrend = readStoredIndicatorOn(CHART_SHOW_ST_STORAGE_KEY, true);
    /** Liquidation markers collected from `force_order` messages. */
    this._liquidationMarkers = [];
    this._liquidationsEnabled = readStoredIndicatorOn(LIQUIDATION_MARKERS_STORAGE_KEY, true);
    /** Last mark price for the chart mark-price partial line. */
    this._lastMarkPrice = null;
    /** OI regime overlay state. */
    this._oiRegime = null;
    this._oiRegimeEnabled = readStoredIndicatorOn(OI_REGIME_STORAGE_KEY, true);
    this._oiRegimePriceLine = null;
    /** Session VWAP series. */
    this._vwapSeries = null;
    this._vwapEnabled = readStoredIndicatorOn(VWAP_STORAGE_KEY, false);
    /** RSI(14) sub-panel series. */
    this._rsiSeries = null;
    this._rsiEnabled = readStoredIndicatorOn(RSI_STORAGE_KEY, false);
    /** Funding rate axis label. */
    this._fundingPriceLine = null;
    this._lastFunding = null;
    /** Spread heatmap on forming volume bar. */
    this._currentSpreadBps = null;
    this._spreadHeatmapEnabled = readStoredIndicatorOn(SPREAD_HEATMAP_STORAGE_KEY, false);
    /** TFI histogram lane. */
    this._tfiSeries = null;
    this._tfiEnabled = readStoredIndicatorOn(TFI_STORAGE_KEY, false);
    this._tfiBarMap = new Map();
    /** Depth pressure zone line. */
    this._depthPressureEnabled = readStoredIndicatorOn(DEPTH_PRESSURE_STORAGE_KEY, false);
    this._lastDepthPressure = null;
    /** OBI-tinted candle wick/border. */
    this._obiTintEnabled = readStoredIndicatorOn(OBI_TINT_STORAGE_KEY, false);
    this._currentObi = null;
    /** Micro-candle sub-chart. */
    this._microChart = null;
    this._microCandleSeries = null;
    this._microEnabled = readStoredIndicatorOn(MICRO_CHART_STORAGE_KEY, false);
  }

  _readSmcOverlayEnabled() {
    try {
      return localStorage.getItem(SMC_OVERLAY_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  }

  _storeSmcOverlayEnabled(on) {
    try {
      localStorage.setItem(SMC_OVERLAY_STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  _readKnnArchitectureEnabled() {
    try {
      return localStorage.getItem(KNN_ARCHITECTURE_STORAGE_KEY) !== '0';
    } catch {
      return true;
    }
  }

  _storeKnnArchitectureEnabled(on) {
    try {
      localStorage.setItem(KNN_ARCHITECTURE_STORAGE_KEY, on ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  _clearSmcChartVisuals() {
    if (this.candleSeries && this._smcSignalPriceLines?.length) {
      for (const pl of this._smcSignalPriceLines) {
        try {
          this.candleSeries.removePriceLine(pl);
        } catch {
          /* ignore */
        }
      }
    }
    this._smcSignalPriceLines = [];
    this._lastSmcMarkers = [];
    this._paintAllMarkers();
    this._smcZonePrimitive?.setZones([]);
    this._smcZonePrimitive?.setLines([]);
  }

  /** Map server SMC bar index → chart unix seconds (LW `time`). */
  _signalBarTimeSec(tf, idx) {
    const raw = this.candleMap[tf];
    if (!raw?.length || idx == null || !Number.isFinite(idx)) return null;
    const sorted = this._sortedDedupeCandles(raw);
    const i = Math.trunc(idx);
    if (i < 0 || i >= sorted.length) return null;
    const t = Math.floor(sorted[i].openTime / 1000);
    return Number.isFinite(t) ? t : null;
  }

  _lastVisibleBarTimeSec(tf) {
    const raw = this.candleMap[tf];
    if (!raw?.length) return null;
    const sorted = this._sortedDedupeCandles(raw);
    const t = Math.floor(sorted[sorted.length - 1].openTime / 1000);
    return Number.isFinite(t) ? t : null;
  }

  _addSmcPriceLine(price, color, title, lineStyle) {
    if (!this.candleSeries || !Number.isFinite(price)) return;
    const showAxis = title === 'REF';
    const line = this.candleSeries.createPriceLine({
      price,
      color,
      lineWidth: 1,
      lineStyle: lineStyle ?? LineStyle.Dashed,
      lineVisible: true,
      axisLabelVisible: showAxis,
      title: showAxis ? title : '',
      axisLabelColor: color,
    });
    this._smcSignalPriceLines.push(line);
  }

  _paintSmcFromStoredSignals() {
    this._clearSmcChartVisuals();
    if ((!this._smcSignalsOverlayEnabled && !this._knnArchitectureEnabled) || !this._lastSignalsForChart || !this.candleSeries) return;
    
    const s = this._lastSignalsForChart;
    const refTf = s.refPriceTf || this.currentTf;

    const smc = this._smcSignalsOverlayEnabled ? s.smc : null;
    const knn = (this._knnArchitectureEnabled && s.knnArchitecture) ? s.knnArchitecture : null;
    
    const markers = [];
    /** @type {{ t1: number; t2: number; top: number; bottom: number; fill: string; stroke?: string; text?: string; textColor?: string }[]} */
    const smcZones = [];
    /** @type {{ t1: number; t2: number; price: number; color: string; label?: string; lineWidth?: number; lineStyle?: number }[]} */
    const smcStructLines = [];
    const lastT = this._lastVisibleBarTimeSec(refTf) || this._lastVisibleBarTimeSec(this.currentTf) || Math.floor(Date.now() / 1000);

    if (smc) {
      // 1. Order Blocks
      if (Array.isArray(smc.orderBlocks)) {
        for (const ob of smc.orderBlocks) {
          const tOb = this._signalBarTimeSec(refTf, ob.index);
          if (tOb != null) {
            const bull = ob.type === 'BULLISH';
            markers.push({
              time: tOb,
              position: bull ? 'belowBar' : 'aboveBar',
              shape: 'square',
              color: bull ? '#26a69a' : '#ef5350',
              text: 'OB',
              size: 0.8,
            });

            if (lastT != null) {
              const isInst = ob.score >= 6;
              const alpha = ob.isMitigated ? 0.08 : (isInst ? 0.45 : 0.30);
              const strokeAlpha = ob.isMitigated ? 0.2 : 0.7;
              smcZones.push({
                t1: tOb, t2: lastT, top: ob.high, bottom: ob.low,
                fill: bull ? `rgba(38,166,154,${alpha})` : `rgba(239,83,80,${alpha})`,
                stroke: bull ? `rgba(38,166,154,${strokeAlpha})` : `rgba(239,83,80,${strokeAlpha})`,
                text: (isInst ? 'Inst. ' : '') + (bull ? 'Demand' : 'Supply') + (ob.isMitigated ? ' (Mit)' : ''),
                textColor: bull ? 'rgba(200,255,240,0.95)' : 'rgba(255,220,220,0.95)',
              });
            }
          }
        }
      }

      // 2. Fair Value Gaps
      if (Array.isArray(smc.fvgs)) {
        for (const fvg of smc.fvgs) {
          const tFvg = this._signalBarTimeSec(refTf, fvg.index);
          if (tFvg != null && lastT != null) {
            const isHighValue = fvg.score >= 2;
            const alpha = isHighValue ? 0.35 : 0.20;
            smcZones.push({
              t1: tFvg, t2: lastT, top: fvg.high, bottom: fvg.low,
              fill: `rgba(255,193,7,${alpha})`, 
              stroke: `rgba(255,193,7,${isHighValue ? 0.6 : 0.4})`,
              text: isHighValue ? 'Propulsion FVG' : 'FVG',
              textColor: 'rgba(255,236,179,0.9)',
            });
          }
        }
      }

      // 3. Dealing Range
      if (smc.dealingRange && lastT != null) {
        const dr = smc.dealingRange;
        const startT = lastT - 3600 * 4; 
        smcZones.push({ t1: startT, t2: lastT, top: dr.high, bottom: dr.equilibrium, fill: 'rgba(239,83,80,0.06)', text: 'PREMIUM', textColor: 'rgba(239,83,80,0.4)' });
        smcZones.push({ t1: startT, t2: lastT, top: dr.equilibrium, bottom: dr.low, fill: 'rgba(38,166,154,0.06)', text: 'DISCOUNT', textColor: 'rgba(38,166,154,0.4)' });
        smcStructLines.push({ t1: startT, t2: lastT, price: dr.equilibrium, color: 'rgba(176,190,197,0.5)', label: 'EQ', lineWidth: 1 });
      }

      // 4. Breaker Blocks
      if (Array.isArray(smc.breakers)) {
        for (const bb of smc.breakers) {
          const tBb = this._signalBarTimeSec(refTf, bb.index);
          if (tBb != null && lastT != null) {
            const bull = bb.type === 'BULLISH';
            smcZones.push({
              t1: tBb, t2: lastT, top: bb.high, bottom: bb.low,
              fill: 'rgba(126,87,194,0.25)', stroke: 'rgba(126,87,194,0.5)',
              text: bull ? 'Bull Breaker' : 'Bear Breaker', textColor: 'rgba(209,196,233,0.9)',
            });
          }
        }
      }

      // 5. Generic Blocks
      if (Array.isArray(smc.blocks)) {
        for (const blk of smc.blocks) {
          const t1 = this._signalBarTimeSec(refTf, blk.startIndex);
          const t2 = this._signalBarTimeSec(refTf, blk.endIndex) || lastT;
          if (t1 != null && t2 != null) {
            let fill = 'rgba(144,164,174,0.2)', stroke = 'rgba(144,164,174,0.5)', textColor = 'rgba(207,216,220,0.95)';
            if (blk.type === 'LIQUIDITY') { 
              fill = 'rgba(0,188,212,0.25)'; 
              stroke = 'rgba(0,188,212,0.6)'; 
              textColor = 'rgba(178,235,242,0.95)'; 
            } else if (blk.type === 'SESSION') { 
              fill = 'rgba(100,181,246,0.15)'; 
              stroke = 'rgba(100,181,246,0.4)'; 
              textColor = 'rgba(187,222,251,0.95)'; 
            }
            smcZones.push({ t1, t2, top: blk.high, bottom: blk.low, fill, stroke, text: blk.subType, textColor });
          }
        }
      }

      // 6. BOS/CHoCH Markers
      if (lastT != null) {
        if (smc.bos && smc.bos !== 'NONE') {
          const bull = smc.bos === 'BULLISH';
          const tBos = smc.bosLine && Number.isFinite(smc.bosLine.endIndex) ? this._signalBarTimeSec(refTf, smc.bosLine.endIndex) : null;
          markers.push({ time: tBos ?? lastT, position: 'aboveBar', shape: bull ? 'arrowUp' : 'arrowDown', color: '#b388ff', text: 'BOS', id: 'smc-bos' });
        }
        if (smc.choch && smc.choch !== 'NONE') {
          const bull = smc.choch === 'BULLISH';
          const tChoch = smc.chochLine && Number.isFinite(smc.chochLine.endIndex) ? this._signalBarTimeSec(refTf, smc.chochLine.endIndex) : null;
          markers.push({ time: tChoch ?? lastT, position: 'belowBar', shape: bull ? 'arrowUp' : 'arrowDown', color: '#80cbc4', text: 'CHoCH', id: 'smc-choch' });
        }
        if (Array.isArray(smc.swings)) {
          for (const sw of smc.swings) {
            const tSw = this._signalBarTimeSec(refTf, sw.index);
            if (tSw) markers.push({ time: tSw, position: sw.kind === 'high' ? 'aboveBar' : 'belowBar', shape: 'circle', color: sw.kind === 'high' ? 'rgba(255,82,82,0.3)' : 'rgba(0,230,118,0.3)', size: 0.2 });
          }
        }
      }

      // 7. Structural Labels
      if (Array.isArray(smc.structPoints)) {
        for (const sp of smc.structPoints) {
          const tSp = this._signalBarTimeSec(refTf, sp.swing.index);
          if (tSp) markers.push({ time: tSp, position: sp.swing.kind === 'high' ? 'aboveBar' : 'belowBar', shape: 'circle', color: sp.swing.kind === 'high' ? '#ff5252' : '#00e676', text: sp.label.toUpperCase(), size: 0.1 });
        }
      }

      // 8. Liquidity
      let hasLiqSweepMarker = false;
      const liq = smc.liquidity;
      if (liq && typeof liq === 'object') {
        const pools = Array.isArray(liq.pools) ? liq.pools : [];
        for (const p of pools) {
          if (Number.isFinite(p.price)) {
            const bullPool = p.kind === 'buyside' || p.kind === 'BUYSIDE';
            this._addSmcPriceLine(p.price, bullPool ? 'rgba(255,128,171,0.5)' : 'rgba(128,203,255,0.5)', bullPool ? 'LQ↑' : 'LQ↓', LineStyle.Dotted);
          }
        }
        const pr = liq.primaryRejection;
        if (pr && pr.outcome === 'rejection' && pr.sweepBarIndex != null) {
          const tSweep = this._signalBarTimeSec(refTf, pr.sweepBarIndex);
          if (tSweep != null) {
            const buyRaid = pr.poolKind === 'buyside' || pr.poolKind === 'BUYSIDE';
            markers.push({ time: tSweep, position: buyRaid ? 'aboveBar' : 'belowBar', shape: buyRaid ? 'arrowDown' : 'arrowUp', color: '#ff80ab', text: `LQ${pr.raidDirection === 'DOWN' ? '↓' : '↑'}${Number(pr.score) || 0}` });
            hasLiqSweepMarker = true;
          }
        }
      }
      if (smc.liquiditySweep && smc.liquiditySweep !== 'NONE' && !hasLiqSweepMarker) {
        markers.push({ time: lastT, position: 'inBar', shape: 'circle', color: '#ff80ab', text: 'LS' });
      }

      // 9. Structure Segments
      const pushSmcStructureSegment = (line, color, label, position) => {
        if (!line || !Number.isFinite(line.price)) return;
        const tA = this._signalBarTimeSec(refTf, line.startIndex);
        const tB = this._signalBarTimeSec(refTf, line.endIndex) ?? lastT;
        if (tA != null && tB != null) {
          const t1 = Math.min(tA, tB), t2 = Math.max(tA, tB);
          if (t2 > t1) smcStructLines.push({ t1, t2, price: line.price, color, label, position, lineWidth: 2 });
        }
      };
      if (smc.bos && smc.choch && smc.bosLine && smc.chochLine && smc.bosLine.startIndex === smc.chochLine.startIndex && smc.bosLine.endIndex === smc.chochLine.endIndex && Math.abs(smc.bosLine.price - smc.chochLine.price) < 1e-10) {
        pushSmcStructureSegment(smc.bosLine, '#a389d4', 'BOS · CHoCH', smc.bos === 'BULLISH' ? 'top' : 'bottom');
      } else {
        if (smc.bos && smc.bos !== 'NONE') pushSmcStructureSegment(smc.bosLine, '#b388ff', 'BOS', smc.bos === 'BULLISH' ? 'top' : 'bottom');
        if (smc.choch && smc.choch !== 'NONE') pushSmcStructureSegment(smc.chochLine, '#80cbc4', 'CHoCH', smc.choch === 'BULLISH' ? 'top' : 'bottom');
      }
    }

    if (knn) {
      const profileWidthSec = 3600 * 6;
      const chartRightEdge = lastT + profileWidthSec;

      const renderKnnLine = (lineData, color, style, label) => {
        if (lineData.high != null) {
          const t1 = (lineData.highIndex != null) ? (this._signalBarTimeSec(refTf, lineData.highIndex) ?? lastT - 3600 * 12) : lastT - 3600 * 12;
          smcStructLines.push({ t1, t2: chartRightEdge, price: lineData.high, color, label, lineWidth: 1.5, lineStyle: style, position: 'top' });
        }
        if (lineData.low != null) {
          const t1 = (lineData.lowIndex != null) ? (this._signalBarTimeSec(refTf, lineData.lowIndex) ?? lastT - 3600 * 12) : lastT - 3600 * 12;
          smcStructLines.push({ t1, t2: chartRightEdge, price: lineData.low, color, label, lineWidth: 1.5, lineStyle: style, position: 'bottom' });
        }
      };

      renderKnnLine(knn.stLines, 'rgba(176,190,197,0.5)', 2, 'ST');
      renderKnnLine(knn.mtLines, 'rgba(207,216,220,0.7)', 1, 'MT');
      renderKnnLine(knn.ltLines, 'rgba(255,255,255,0.9)', 0, 'LT');

      const addBosLines = (list, label, color, lineStyle) => {
        for (const b of list) {
          const tBreak = this._signalBarTimeSec(refTf, b.index);
          const tFrom = this._signalBarTimeSec(refTf, b.fromIndex);
          if (!tBreak) continue;
          const t1 = tFrom ?? tBreak - 3600 * 2;
          smcStructLines.push({
            t1, t2: tBreak, price: b.price,
            color, label, lineWidth: 1, lineStyle,
            position: b.type === 'BULLISH' ? 'top' : 'bottom',
          });
        }
      };
      addBosLines(knn.stBOS, 'ST BOS', '#ef5350', 2);
      addBosLines(knn.mtBOS, 'MT BOS', '#ef5350', 1);
      addBosLines(knn.ltBOS, 'LT BOS', '#26a69a', 0);

      for (const tank of knn.deltaTanks) {
        const isBull = tank.delta >= 0;
        const color = isBull ? '#00e676' : '#ff5252';
        const fill = isBull ? 'rgba(0,230,118,0.15)' : 'rgba(255,82,82,0.15)';
        const absRatio = Math.min(1, Math.abs(tank.ratio));

        smcZones.push({
          t1: lastT, t2: chartRightEdge,
          top: tank.price * 1.002, bottom: tank.price * 0.998,
          fill, stroke: color,
          tankRatio: absRatio,
          text: `[ DELTA TANK ] ▼\n${(absRatio * 100).toFixed(0)}%`,
          textColor: '#ffffff', labelAlign: 'right',
        });
      }

      if (Array.isArray(knn.volumeProfile) && knn.volumeProfile.length > 1) {
        const maxVol = Math.max(...knn.volumeProfile.map(v => v.volume));
        const binHeight = (knn.volumeProfile[1].price - knn.volumeProfile[0].price) * 0.98;
        const pocPrice = knn.volumeProfile.find(b => b.isPoc)?.price;
        const midPrice = pocPrice ?? ((knn.ltLines.high || 0) + (knn.ltLines.low || 0)) / 2;

        for (const bin of knn.volumeProfile) {
          if (bin.volume === 0) continue;
          const binWidth = (bin.volume / maxVol) * profileWidthSec;
          const above = bin.price >= midPrice;

          smcZones.push({
            t1: chartRightEdge - binWidth, t2: chartRightEdge,
            top: bin.price + binHeight / 2, bottom: bin.price - binHeight / 2,
            fill: bin.isPoc ? 'rgba(255,255,255,0.35)' : (above ? 'rgba(38,166,154,0.25)' : 'rgba(239,83,80,0.25)'),
            stroke: bin.isPoc ? '#ffffff' : 'rgba(255,255,255,0.08)',
            isVolumeProfile: true,
          });
        }
      }
    }

    if (Number.isFinite(s.refPrice)) this._addSmcPriceLine(s.refPrice, 'rgba(184,134,255,0.9)', 'REF', LineStyle.Dotted);
    this._smcZonePrimitive?.setZones(smcZones);
    this._smcZonePrimitive?.setLines(smcStructLines);
    this._lastSmcMarkers = markers;
    this._paintAllMarkers();
  }

  /**
   * Draw SMC zones / markers from dashboard `signals` (same payload as Strategy Signals panel).
   * @param {object | null} signals — omit or null to clear.
   */
  applySignalOverlays(signals) {
    if (!signals) {
      this._lastSignalsForChart = null;
      this._clearSmcChartVisuals();
      this.updateStrategyHud(null);
      return;
    }
    this._lastSignalsForChart = signals;
    this._paintSmcFromStoredSignals();
    this.updateStrategyHud(signals);
  }

  /**
   * Floating readout (verdict, HTF/LTF, SMC / MTF summary). Independent of SMC price lines.
   * @param {object | null} signals — same payload as `applySignalOverlays`; null clears.
   */
  updateStrategyHud(signals) {
    const el = document.getElementById('chart-signal-hud');
    if (!el) return;
    if (!this._signalHudEnabled) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    renderStrategyHud(el, signals);
  }

  _volumeBarColor(candleRow) {
    const up = this._volumeColorUp;
    const down = this._volumeColorDown;
    const base = (!up || !down)
      ? (candleRow.close >= candleRow.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)')
      : (candleRow.close >= candleRow.open ? up : down);
    if (this._spreadHeatmapEnabled && this._currentSpreadBps != null && this._currentSpreadBps > 0.5) {
      if (this._currentSpreadBps > 2) return 'rgba(255,152,0,0.7)';
      return 'rgba(255,235,59,0.5)';
    }
    return base;
  }

  /**
   * @param {string} themeId
   * @param {{ persist?: boolean }} [opts]
   */
  _applyCandleTheme(themeId, opts = {}) {
    const { persist = true } = opts;
    const t = getCandleTheme(themeId);
    if (persist) storeCandleThemeId(t.id);
    const vol = getHistogramBarColors(t);
    this._volumeColorUp = vol.up;
    this._volumeColorDown = vol.down;
    this.candleSeries?.applyOptions(t.candle);
    this.volumeSeries?.applyOptions({ color: vol.up });
    const raw = this.candleMap[this.currentTf];
    if (raw?.length) this._loadTf(this.currentTf, { preserveVisibleRange: true });
    this._syncCandleThemeDropdown(t.id);
  }

  /** @param {string} themeId */
  _syncCandleThemeDropdown(themeId) {
    const t = getCandleTheme(themeId);
    const labelEl = document.getElementById('candle-theme-trigger-label');
    const menu = document.getElementById('candle-theme-menu');
    if (labelEl) labelEl.textContent = t.label;
    if (menu) {
      menu.querySelectorAll('[role="option"]').forEach((node) => {
        const id = node.getAttribute('data-theme-id');
        node.setAttribute('aria-selected', id === themeId ? 'true' : 'false');
      });
    }
  }

  _closeCandleThemeMenu() {
    const menu = document.getElementById('candle-theme-menu');
    const trigger = document.getElementById('candle-theme-trigger');
    if (menu) menu.hidden = true;
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (this._candleThemeDocCloseUnsub) {
      this._candleThemeDocCloseUnsub();
      this._candleThemeDocCloseUnsub = null;
    }
  }

  _openCandleThemeMenu() {
    const wrap = document.getElementById('candle-theme-wrap');
    const menu = document.getElementById('candle-theme-menu');
    const trigger = document.getElementById('candle-theme-trigger');
    if (!wrap || !menu || !trigger) return;
    if (this._candleThemeDocCloseUnsub) return;
    this._syncCandleThemeDropdown(readStoredCandleThemeId());
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    const onDoc = (e) => {
      const t = e.target;
      if (!(t instanceof Node) || !wrap.contains(t)) this._closeCandleThemeMenu();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') this._closeCandleThemeMenu();
    };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    this._candleThemeDocCloseUnsub = () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
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

  /**
   * Typical price (H+L+C)/3 and volume of the latest `1m` candle — fallback when the rolling trade window is empty.
   * @returns {{ vwap: number | null; volume: number | null }}
   */
  getLast1mCandleTypicalAndVolume() {
    const raw = this.candleMap['1m'];
    if (!raw?.length) return { vwap: null, volume: null };
    const sorted = this._sortedDedupeCandles(raw);
    const c = sorted[sorted.length - 1];
    if (!c) return { vwap: null, volume: null };
    const h = Number(c.high);
    const l = Number(c.low);
    const cl = Number(c.close);
    const v = Number(c.volume);
    if (![h, l, cl, v].every(Number.isFinite)) return { vwap: null, volume: null };
    const tp = (h + l + cl) / 3;
    return { vwap: tp, volume: v >= 0 ? v : null };
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

  _cancelVolAnim() {
    if (this._volRafId != null) {
      cancelAnimationFrame(this._volRafId);
      this._volRafId = null;
    }
  }

  _resetVolumeAnimState() {
    this._cancelVolAnim();
    this._volDisplay = null;
    this._volTarget = null;
    this._volAnimBarTime = null;
    this._volAnimColor = '';
  }

  _snapVolumeDisplay(time, value, color) {
    this._cancelVolAnim();
    this._volAnimBarTime = time;
    this._volDisplay = value;
    this._volTarget = value;
    this._volAnimColor = color;
    if (!this.volumeSeries) return;
    try {
      this.volumeSeries.update({ time, value, color });
    } catch (e) {
      console.warn('[chart] volume snap failed', e);
    }
  }

  /**
   * While the current candle is forming, Binance volume is non-decreasing. Ease the displayed bar
   * height toward the server value so the histogram rises in small steps instead of jumping.
   */
  _smoothVolumeTo(time, targetVol, color) {
    if (!this.volumeSeries || !Number.isFinite(time) || !Number.isFinite(targetVol)) return;
    if (Number.isFinite(this._volDisplay) && targetVol < this._volDisplay) {
      this._snapVolumeDisplay(time, targetVol, color);
      return;
    }
    this._volAnimColor = color;
    if (this._volAnimBarTime !== time) {
      this._snapVolumeDisplay(time, targetVol, color);
      return;
    }
    if (this._volDisplay == null || !Number.isFinite(this._volDisplay)) {
      this._snapVolumeDisplay(time, targetVol, color);
      return;
    }
    this._volTarget = targetVol;
    if (this._volDisplay >= this._volTarget) {
      this._volDisplay = this._volTarget;
      try {
        this.volumeSeries.update({ time, value: this._volDisplay, color });
      } catch (e) {
        console.warn('[chart] volume update failed', e);
      }
      return;
    }
    if (this._volRafId == null) {
      this._volRafId = requestAnimationFrame(() => this._volAnimStep());
    }
  }

  _volAnimStep() {
    this._volRafId = null;
    if (
      this.volumeSeries == null ||
      this._volAnimBarTime == null ||
      this._volTarget == null ||
      this._volDisplay == null
    ) {
      return;
    }
    if (this._volDisplay >= this._volTarget) {
      this._volDisplay = this._volTarget;
      try {
        this.volumeSeries.update({
          time: this._volAnimBarTime,
          value: this._volDisplay,
          color: this._volAnimColor,
        });
      } catch (e) {
        console.warn('[chart] volume anim failed', e);
      }
      return;
    }
    const delta = this._volTarget - this._volDisplay;
    const step = Math.max(1, Math.min(delta, Math.ceil(delta / 12)));
    this._volDisplay += step;
    try {
      this.volumeSeries.update({
        time: this._volAnimBarTime,
        value: this._volDisplay,
        color: this._volAnimColor,
      });
    } catch (e) {
      console.warn('[chart] volume anim step failed', e);
      return;
    }
    if (this._volDisplay < this._volTarget) {
      this._volRafId = requestAnimationFrame(() => this._volAnimStep());
    }
  }

  _syncBookTopLines() {
    if (!this._partialLinesPrimitive) return;
    if (!this._bookTopLinesEnabled) {
      this._partialLinesPrimitive.removeLine('bid');
      this._partialLinesPrimitive.removeLine('ask');
      return;
    }
    const bid = this._lastBookBid;
    const ask = this._lastBookAsk;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid > ask) {
      this._partialLinesPrimitive.removeLine('bid');
      this._partialLinesPrimitive.removeLine('ask');
      return;
    }
    const startTime = this._latestCandleTimeSec() ?? Math.floor(Date.now() / 1000);
    this._partialLinesPrimitive.setLine('bid', {
      startTimeSec: startTime, price: bid, color: 'rgba(0,200,220,0.82)',
      title: 'BID', axisLabelColor: 'rgba(0,200,220,0.95)', axisLabelTextColor: '#e0f7fa',
    });
    this._partialLinesPrimitive.setLine('ask', {
      startTimeSec: startTime, price: ask, color: 'rgba(255,160,0,0.82)',
      title: 'ASK', axisLabelColor: 'rgba(255,160,0,0.95)', axisLabelTextColor: '#fff3e0',
    });
  }

  setBookTopLevels(bid, ask) {
    const b = Number.isFinite(bid) ? bid : null;
    const a = Number.isFinite(ask) ? ask : null;
    if (b == null || a == null) {
      this._lastBookBid = null;
      this._lastBookAsk = null;
      this._partialLinesPrimitive?.removeLine('bid');
      this._partialLinesPrimitive?.removeLine('ask');
      return;
    }
    this._lastBookBid = b;
    this._lastBookAsk = a;
    this._syncBookTopLines();
  }

  // ── 24h High / Low + helpers ──────────────────────────────────────────

  _findCandleTimeSec(matchFn) {
    const candles = this.candleMap[this.currentTf];
    if (!candles?.length) return null;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (matchFn(candles[i])) return Math.floor(candles[i].openTime / 1000);
    }
    return null;
  }

  _latestCandleTimeSec() {
    const candles = this.candleMap[this.currentTf];
    if (!candles?.length) return null;
    return Math.floor(candles[candles.length - 1].openTime / 1000);
  }

  _sync24hLines() {
    if (!this._partialLinesPrimitive) return;
    const endTime = this._latestCandleTimeSec();
    if (endTime == null) {
      this._partialLinesPrimitive.removeLine('high24h');
      this._partialLinesPrimitive.removeLine('low24h');
      return;
    }

    if (this._lastHigh24h != null) {
      const startTime = this._findCandleTimeSec((c) => c.high === this._lastHigh24h) ?? endTime;
      this._partialLinesPrimitive.setLine('high24h', {
        startTimeSec: startTime, price: this._lastHigh24h, color: 'rgba(255,255,255,0.25)',
        title: '24h High',
      });
    } else {
      this._partialLinesPrimitive.removeLine('high24h');
    }

    if (this._lastLow24h != null) {
      const startTime = this._findCandleTimeSec((c) => c.low === this._lastLow24h) ?? endTime;
      this._partialLinesPrimitive.setLine('low24h', {
        startTimeSec: startTime, price: this._lastLow24h, color: 'rgba(255,255,255,0.25)',
        title: '24h Low',
      });
    } else {
      this._partialLinesPrimitive.removeLine('low24h');
    }
  }

  set24hHighLow(high, low) {
    this._lastHigh24h = Number.isFinite(high) ? high : null;
    this._lastLow24h = Number.isFinite(low) ? low : null;
    this._sync24hLines();
  }

  // ── Liquidation Cascade Markers ─────────────────────────────────────

  addLiquidationMarker(msg) {
    if (!this._liquidationsEnabled) return;
    const price = Number(msg.price);
    const qty = Number(msg.qty);
    const time = Math.floor(Number(msg.tradeTime) / 1000);
    if (!Number.isFinite(price) || !Number.isFinite(time)) return;
    const isLongLiq = msg.side === 'SELL';
    this._liquidationMarkers.push({
      time,
      position: isLongLiq ? 'aboveBar' : 'belowBar',
      shape: isLongLiq ? 'arrowDown' : 'arrowUp',
      color: isLongLiq ? COLORS.bear : COLORS.ltpBull,
      text: `LIQ ${Number.isFinite(qty) ? qty.toFixed(1) : ''}`,
      size: 1,
      id: `liq-${time}-${msg.side}`,
    });
    if (this._liquidationMarkers.length > 200) {
      this._liquidationMarkers = this._liquidationMarkers.slice(-200);
    }
    this._paintAllMarkers();
  }

  _paintAllMarkers() {
    if (!this.candleSeries) return;
    const smcMarkers = this._lastSmcMarkers ?? [];
    const liqMarkers = this._liquidationsEnabled ? this._liquidationMarkers : [];
    const posMarkers = this._positionMarkers ?? [];
    const all = [...smcMarkers, ...liqMarkers, ...posMarkers].sort((a, b) => a.time - b.time);
    try {
      this.candleSeries.setMarkers(all);
    } catch (e) {
      console.warn('[chart] setMarkers failed', e);
    }
  }

  _currentPositionRefPrice() {
    if (Number.isFinite(this._lastMarkPrice)) return this._lastMarkPrice;
    if (Number.isFinite(this._lastBookBid) && Number.isFinite(this._lastBookAsk)) {
      return (this._lastBookBid + this._lastBookAsk) / 2;
    }
    const close = this.getLastCloseForTf(this.currentTf);
    return Number.isFinite(close) ? close : null;
  }

  _positionPnlText(pos, currentPrice) {
    const entry = Number(pos.entryPrice);
    const qty = Number(pos.quantity);
    const side = String(pos.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const dir = side === 'LONG' ? 1 : -1;
    const provided = Number(pos.unrealizedUsdt);
    const pnl = Number.isFinite(provided) && String(pos.mode || '').toLowerCase() !== 'live'
      ? provided
      : (Number.isFinite(currentPrice) && Number.isFinite(entry) && Number.isFinite(qty)
          ? (currentPrice - entry) * qty * dir
          : 0);
    const leverage = Number(pos.leverage);
    const margin = Number.isFinite(pos.marginUsdt) && pos.marginUsdt > 0
      ? pos.marginUsdt
      : (Number.isFinite(leverage) && leverage > 0 && Number.isFinite(entry) && Number.isFinite(qty)
          ? (entry * qty) / leverage
          : null);
    const pct = margin && margin > 0 ? (pnl / margin) * 100 : null;
    return {
      pnl,
      pct,
      text:
        `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT` +
        (pct != null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''),
    };
  }

  setOpenPositions(positions, symbolFilter = null) {
    if (!this.candleSeries || !this._partialLinesPrimitive) return;
    const filter = symbolFilter ? String(symbolFilter).trim().toUpperCase() : null;
    const list = Array.isArray(positions) ? positions : [];
    const currentPrice = this._currentPositionRefPrice();
    const nextMarkers = [];
    const nextIds = new Set();

    for (const pos of list) {
      if (!pos || typeof pos !== 'object') continue;
      const symbol = String(pos.symbol || '').trim().toUpperCase();
      if (!symbol) continue;
      if (filter && symbol !== filter) continue;
      const orderId = String(pos.orderId || `${symbol}:${pos.openedAt ?? ''}:${pos.entryPrice ?? ''}`);
      const entryPrice = Number(pos.entryPrice);
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
      const openedAt = Number(pos.openedAt);
      const startTimeSec = Number.isFinite(openedAt) ? Math.floor(openedAt / 1000) : this._latestCandleTimeSec();
      const side = String(pos.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
      const sideColor = side === 'LONG' ? COLORS.ltpBull : COLORS.bear;
      const pnlInfo = this._positionPnlText(pos, currentPrice);
      nextIds.add(orderId);
      this._openPositionLines.set(orderId, { ...pos });
      this._partialLinesPrimitive.setLine(`pos-${orderId}`, {
        startTimeSec: Number.isFinite(startTimeSec) ? startTimeSec : Math.floor(Date.now() / 1000),
        price: entryPrice,
        color: sideColor,
        lineWidth: 1,
        title: `${side} ENTRY ${fmtLtpDisplay(entryPrice)} | ${pnlInfo.text}`,
        axisLabelColor: sideColor,
      });
      nextMarkers.push({
        time: Number.isFinite(startTimeSec) ? startTimeSec : Math.floor(Date.now() / 1000),
        position: side === 'LONG' ? 'belowBar' : 'aboveBar',
        shape: side === 'LONG' ? 'arrowUp' : 'arrowDown',
        color: sideColor,
        text: `${side} ENTRY`,
        size: 1,
        id: `pos-${orderId}`,
      });
    }

    for (const [orderId] of this._openPositionLines) {
      if (nextIds.has(orderId)) continue;
      this._partialLinesPrimitive.removeLine(`pos-${orderId}`);
      this._openPositionLines.delete(orderId);
    }

    this._positionMarkers = nextMarkers;
    this._paintAllMarkers();
  }

  // ── Mark Price Line ─────────────────────────────────────────────────

  setMarkPrice(price) {
    const p = Number.isFinite(price) ? price : null;
    this._lastMarkPrice = p;
    this._syncMarkLine();
  }

  _syncMarkLine() {
    if (!this._partialLinesPrimitive) return;
    if (this._lastMarkPrice == null) {
      this._partialLinesPrimitive.removeLine('mark');
      return;
    }
    const startTime = this._latestCandleTimeSec() ?? Math.floor(Date.now() / 1000);
    this._partialLinesPrimitive.setLine('mark', {
      startTimeSec: startTime,
      price: this._lastMarkPrice,
      color: 'rgba(255,255,255,0.15)',
      dash: [2, 3],
      title: 'MARK',
      axisLabelColor: 'rgba(255,255,255,0.25)',
      axisLabelTextColor: '#b0bec5',
    });
  }

  // ── OI Regime Overlay ───────────────────────────────────────────────

  setOiRegime(msg) {
    if (!msg || !msg.regime) {
      this._oiRegime = null;
      this._syncOiRegimeOverlay();
      return;
    }
    this._oiRegime = msg;
    this._syncOiRegimeOverlay();
  }

  _syncOiRegimeOverlay() {
    if (!this.candleSeries) return;
    if (this._oiRegimePriceLine && this.candleSeries) {
      try { this.candleSeries.removePriceLine(this._oiRegimePriceLine); } catch { /* ignore */ }
      this._oiRegimePriceLine = null;
    }
    if (!this._oiRegimeEnabled || !this._oiRegime || this._oiRegime.regime === 'neutral') return;

    const regime = this._oiRegime.regime;
    const OI_COLORS = {
      price_up_oi_up: '#00c8dc',
      price_up_oi_down: 'rgba(0,200,220,0.45)',
      price_down_oi_up: '#ffa000',
      price_down_oi_down: 'rgba(255,160,0,0.45)',
    };
    const OI_LABELS = {
      price_up_oi_up: '▲P ▲OI  New Longs',
      price_up_oi_down: '▲P ▼OI  Short Squeeze',
      price_down_oi_up: '▼P ▲OI  New Shorts',
      price_down_oi_down: '▼P ▼OI  Long Squeeze',
    };
    const color = OI_COLORS[regime] ?? 'rgba(255,255,255,0.15)';
    const label = OI_LABELS[regime] ?? 'OI';
    const anchorPrice = this._lastMarkPrice ?? this._formingBarCtx?.closeTruth;
    if (!Number.isFinite(anchorPrice)) return;

    this._oiRegimePriceLine = this.candleSeries.createPriceLine({
      price: anchorPrice,
      color: 'transparent',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      lineVisible: false,
      axisLabelVisible: true,
      axisLabelColor: color,
      title: label,
    });
  }

  // ── Funding Rate Overlay ────────────────────────────────────────────

  setFundingRate(msg) {
    this._lastFunding = msg ?? null;
    this._syncFundingOverlay();
  }

  _syncFundingOverlay() {
    if (this._fundingPriceLine && this.candleSeries) {
      try { this.candleSeries.removePriceLine(this._fundingPriceLine); } catch { /* ignore */ }
      this._fundingPriceLine = null;
    }
    if (!this._lastFunding || !this.candleSeries) return;
    const { rate, zscore, extreme, crowdedSide } = this._lastFunding;
    if (!Number.isFinite(rate)) return;

    const pctStr = (rate * 100).toFixed(4) + '%';
    const isNeg = rate < 0;
    const color = extreme
      ? (isNeg ? '#00e5ff' : '#ff5252')
      : (isNeg ? 'rgba(0,229,255,0.5)' : 'rgba(255,82,82,0.5)');
    const label = `FR ${pctStr}${extreme ? ' ⚠' : ''}`;

    const anchorPrice = this._lastMarkPrice ?? this._formingBarCtx?.closeTruth;
    if (!Number.isFinite(anchorPrice)) return;

    const offset = anchorPrice * 0.001;
    this._fundingPriceLine = this.candleSeries.createPriceLine({
      price: anchorPrice + (isNeg ? -offset : offset),
      color: 'transparent',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      lineVisible: false,
      axisLabelVisible: true,
      axisLabelColor: color,
      title: label,
    });
  }

  // ── Feature 22.5: Spread Heatmap ────────────────────────────────────

  setCurrentSpread(spreadBps) {
    this._currentSpreadBps = Number.isFinite(spreadBps) ? spreadBps : null;
  }

  // ── Feature 22.6: TFI Lane ─────────────────────────────────────────

  setTfiSnapshot(tfi5s) {
    if (!this._tfiEnabled || !this._tfiSeries || !tfi5s) return;
    const t = this._latestCandleTimeSec();
    if (!t) return;
    const tfi = Number(tfi5s.tfi);
    if (!Number.isFinite(tfi)) return;
    let color = 'rgba(128,128,128,0.3)';
    if (tfi > 0.3) color = 'rgba(0,200,220,0.6)';
    else if (tfi < -0.3) color = 'rgba(255,160,0,0.6)';
    this._tfiBarMap.set(t, { time: t, value: tfi, color });
    try { this._tfiSeries.update({ time: t, value: tfi, color }); } catch { /* ignore */ }
  }

  // ── Feature 22.7: Depth Pressure Zones ─────────────────────────────

  setDepthPressure(dp) {
    this._lastDepthPressure = dp ?? null;
    this._syncDepthPressureZones();
  }

  _syncDepthPressureZones() {
    if (!this._partialLinesPrimitive || !this._depthPressureEnabled || !this._lastDepthPressure) {
      return;
    }
    const dp = this._lastDepthPressure.depthPressure;
    if (!Number.isFinite(dp) || Math.abs(dp) < 0.1) {
      this._partialLinesPrimitive.removeLine('dp-zone');
      return;
    }
    const anchorPrice = this._lastMarkPrice ?? this._formingBarCtx?.closeTruth;
    if (!Number.isFinite(anchorPrice)) {
      this._partialLinesPrimitive.removeLine('dp-zone');
      return;
    }
    const startTime = this._latestCandleTimeSec() ?? Math.floor(Date.now() / 1000);
    const alpha = Math.min(0.6, Math.abs(dp) * 0.5);
    const isBidDominant = dp > 0;
    const offset = anchorPrice * 0.002 * (isBidDominant ? -1 : 1);
    const color = isBidDominant
      ? `rgba(0,200,220,${alpha.toFixed(2)})`
      : `rgba(255,160,0,${alpha.toFixed(2)})`;
    const label = isBidDominant
      ? `▲BID ${(dp * 100).toFixed(0)}%`
      : `▼ASK ${(Math.abs(dp) * 100).toFixed(0)}%`;
    this._partialLinesPrimitive.setLine('dp-zone', {
      startTimeSec: startTime,
      price: anchorPrice + offset,
      color,
      dash: [1, 4],
      title: label,
      axisLabelColor: color,
    });
  }

  // ── Feature 22.8: OBI-Tinted Candle Borders ────────────────────────

  setObi(obi) {
    this._currentObi = Number.isFinite(obi) ? obi : null;
    this._syncObiTint();
  }

  _syncObiTint() {
    if (!this.candleSeries) return;
    if (!this._obiTintEnabled || this._currentObi == null || Math.abs(this._currentObi) < 0.15) {
      this._restoreDefaultWickColors();
      return;
    }
    const intensity = Math.min(1, Math.abs(this._currentObi));
    const alpha = (0.3 + intensity * 0.5).toFixed(2);
    if (this._currentObi > 0) {
      this.candleSeries.applyOptions({
        wickUpColor: `rgba(0,200,220,${alpha})`,
        wickDownColor: `rgba(0,200,220,${alpha})`,
        borderUpColor: `rgba(0,200,220,${alpha})`,
        borderDownColor: `rgba(0,200,220,${alpha})`,
      });
    } else {
      this.candleSeries.applyOptions({
        wickUpColor: `rgba(255,160,0,${alpha})`,
        wickDownColor: `rgba(255,160,0,${alpha})`,
        borderUpColor: `rgba(255,160,0,${alpha})`,
        borderDownColor: `rgba(255,160,0,${alpha})`,
      });
    }
  }

  _restoreDefaultWickColors() {
    if (!this.candleSeries) return;
    const themeId = readStoredCandleThemeId();
    const theme = getCandleTheme(themeId);
    if (theme?.candle) {
      this.candleSeries.applyOptions({
        wickUpColor: theme.candle.wickUpColor,
        wickDownColor: theme.candle.wickDownColor,
        borderUpColor: theme.candle.borderUpColor,
        borderDownColor: theme.candle.borderDownColor,
      });
    }
  }

  // ── Feature 22.12: Micro-Candle Sub-Chart ──────────────────────────

  _initMicroChart() {
    const container = document.getElementById('micro-chart-container');
    if (!container) return;
    container.style.display = this._microEnabled ? '' : 'none';
    if (this._microChart) return;
    this._microChart = createChart(container, {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: COLORS.text, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', scaleMargins: { top: 0.05, bottom: 0.05 } },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: true, rightOffset: 5 },
      crosshair: { mode: 0 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
      height: 100,
      width: container.clientWidth,
    });
    this._microCandleSeries = this._microChart.addCandlestickSeries({
      upColor: 'rgba(0,200,220,0.6)',
      downColor: 'rgba(255,160,0,0.6)',
      wickUpColor: 'rgba(0,200,220,0.4)',
      wickDownColor: 'rgba(255,160,0,0.4)',
      borderUpColor: 'rgba(0,200,220,0.6)',
      borderDownColor: 'rgba(255,160,0,0.6)',
      lastValueVisible: true,
      priceLineVisible: false,
    });
    if (this._resizeObs) this._resizeObs.observe(container);
  }

  setMicroBars(bars) {
    if (!this._microEnabled || !this._microCandleSeries || !Array.isArray(bars) || bars.length === 0) return;
    const data = bars
      .filter(b => Number.isFinite(b.openTime) && Number.isFinite(b.open))
      .map(b => ({
        time: Math.floor(b.openTime / 1000),
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      }))
      .sort((a, b) => a.time - b.time);
    const deduped = [];
    let prevT = -Infinity;
    for (const d of data) {
      if (d.time === prevT) deduped[deduped.length - 1] = d;
      else { deduped.push(d); prevT = d.time; }
    }
    try { this._microCandleSeries.setData(deduped); } catch (e) { console.warn('[chart] micro setData', e); }
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
    this._partialLinesPrimitive?.removeLine('ltp');
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
    const dispCloseRaw = ltpPriceFromTicks(dispTicks);
    const { time, open, high: hTrue, low: lTrue, closeTruth } = ctx;
    if (![time, open, hTrue, lTrue, closeTruth].every(Number.isFinite)) return;

    /** Keep exchange wicks while close steps — do not shrink H/L toward `dispClose` (that flattens the live bar). */
    const dispClose = Math.min(hTrue, Math.max(lTrue, dispCloseRaw));

    const bar =
      dispTicks === truthTicks
        ? { time, open, high: hTrue, low: lTrue, close: closeTruth }
        : { time, open, high: hTrue, low: lTrue, close: dispClose };
    try {
      this.candleSeries.update(bar);
    } catch (e) {
      console.warn('[chart] forming candle update failed, resyncing series', e);
      this._formingBarCtx = null;
      this._loadTf(this.currentTf, { preserveVisibleRange: true });
    }
  }

  _ensureLtpPriceLine(initialPrice) {
    if (this._ltpPriceLine != null || !this.candleSeries) return;
    this._ltpPriceLine = this.candleSeries.createPriceLine({
      price: initialPrice,
      color: COLORS.bear,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      lineVisible: false,
      axisLabelVisible: true,
      axisLabelColor: COLORS.bear,
    });
  }

  _ltpColor(price) {
    const open = this._formingBarCtx?.open;
    return (Number.isFinite(open) && price >= open) ? COLORS.ltpBull : COLORS.bear;
  }

  _updateLtpVisual(price) {
    if (!this._partialLinesPrimitive) return;
    if (!Number.isFinite(price)) {
      this._partialLinesPrimitive.removeLine('ltp');
      return;
    }
    const color = this._ltpColor(price);
    const startTime = this._latestCandleTimeSec() ?? Math.floor(Date.now() / 1000);
    this._partialLinesPrimitive.setLine('ltp', {
      startTimeSec: startTime, price, color,
    });
    this._ltpPriceLine?.applyOptions({ color, axisLabelColor: color });
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

    const dist = this._ltpTargetTicks - this._ltpDisplayTicks;
    if (Math.abs(dist) < 1) {
      this._ltpDisplayTicks = this._ltpTargetTicks;
    } else {
      // Proportional step: LTP_SMOOTHING of distance per frame (min 1 tick).
      // This makes it extremely responsive while still smooth.
      const step = Math.sign(dist) * Math.max(1, Math.floor(Math.abs(dist) * LTP_SMOOTHING));

      this._ltpDisplayTicks += step;
    }

    const p = ltpPriceFromTicks(this._ltpDisplayTicks);
    this._ltpPriceLine.applyOptions({ price: p });
    this._updateLtpVisual(p);
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
    const color = this._ltpColor(p);
    this._ltpPriceLine.applyOptions({
      price: p,
      lineVisible: false,
      axisLabelVisible: true,
      color,
      axisLabelColor: color,
    });
    this._updateLtpVisual(p);
    this._emitLtpDisplay(p);
    this._refreshFormingCandleFromCtx();
  }

  /**
   * Apply display LTP decimals from dashboard (`ltpDecimalPlaces` = tick fractional digits + display offset). Chart LTP motion
   * uses one extra sub-tick decimal internally; axis labels use display precision via `fmtLtpDisplay`.
   * The price *scale* always uses the raw tick dp (min tick) so axis grid labels never show sub-tick padding.
   * @param {{ ltpDecimalPlaces?: number | null; instrumentPrecision?: { tickSize?: number } | null }} msg
   */
  applyDashboardLtpPrecision(msg) {
    const n = msg?.ltpDecimalPlaces;
    // Compute raw tick dp from tickSize (e.g. 0.01 → 2) for the price scale formatter.
    const tickSize = msg?.instrumentPrecision?.tickSize;
    if (typeof tickSize === 'number' && Number.isFinite(tickSize) && tickSize > 0) {
      const trimmed = tickSize.toFixed(12).replace(/\.?0+$/, '');
      const dot = trimmed.indexOf('.');
      const tickDp = dot < 0 ? 0 : trimmed.slice(dot + 1).length;
      setMinTickDecimalPlacesFromServer(tickDp);
    } else if (n != null && Number.isFinite(n)) {
      // Fallback: use ltpDecimalPlaces as-is (no offset correction available).
      setMinTickDecimalPlacesFromServer(n);
    }
    let anchor = null;
    if (this._ltpTargetTicks != null && Number.isFinite(this._ltpTargetTicks)) {
      anchor = ltpPriceFromTicks(this._ltpTargetTicks);
    }
    setLtpDecimalPlacesFromServer(n != null && Number.isFinite(n) ? n : null);
    if (anchor != null && Number.isFinite(anchor)) this._snapLtpTo(anchor);
    this._syncPriceLocalization();
  }

  _syncPriceLocalization() {
    if (!this.chart) return;
    this.chart.applyOptions({
      localization: {
        locale: typeof navigator !== 'undefined' ? navigator.language : 'en-US',
        // Price scale axis always uses min-tick precision (exchange tick size dp, no display offset).
        priceFormatter: (priceValue) => Number(priceValue).toFixed(getMinTickDecimalPlaces()),
      },
    });
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
    this._syncPriceLocalization();

    const initialTheme = getCandleTheme(readStoredCandleThemeId());
    const initialVol = getHistogramBarColors(initialTheme);
    this._volumeColorUp = initialVol.up;
    this._volumeColorDown = initialVol.down;

    this.candleSeries = this.chart.addCandlestickSeries({
      ...initialTheme.candle,
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this._smcZonePrimitive = new SmcZoneBoxesPrimitive();
    this.candleSeries.attachPrimitive(this._smcZonePrimitive);

    this.volumeSeries = this.chart.addHistogramSeries({
      color: initialTheme.volumeUp,
      base: 0,
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

    this._vwapSeries = this.chart.addLineSeries({
      color: '#e040fb',
      lineWidth: 1.5,
      lineStyle: 0,
      priceScaleId: 'right',
      lastValueVisible: true,
      priceLineVisible: false,
      visible: this._vwapEnabled,
    });

    this._rsiSeries = this.chart.addLineSeries({
      color: '#ce93d8',
      lineWidth: 1.5,
      priceScaleId: 'rsi',
      lastValueVisible: true,
      priceLineVisible: false,
      visible: this._rsiEnabled,
    });
    this.chart.priceScale('rsi').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0.02 },
      borderVisible: false,
      visible: this._rsiEnabled,
    });
    this._rsiSeries.createPriceLine({ price: 70, color: 'rgba(255,82,82,0.3)', lineWidth: 1, lineStyle: LineStyle.Dashed, lineVisible: true, axisLabelVisible: false });
    this._rsiSeries.createPriceLine({ price: 30, color: 'rgba(0,200,220,0.3)', lineWidth: 1, lineStyle: LineStyle.Dashed, lineVisible: true, axisLabelVisible: false });
    this._rsiSeries.createPriceLine({ price: 50, color: 'rgba(255,255,255,0.08)', lineWidth: 1, lineStyle: LineStyle.Dotted, lineVisible: true, axisLabelVisible: false });

    this._tfiSeries = this.chart.addHistogramSeries({
      priceScaleId: 'tfi',
      base: 0,
      priceFormat: { type: 'custom', formatter: (v) => v.toFixed(2) },
      lastValueVisible: false,
      visible: this._tfiEnabled,
    });
    this.chart.priceScale('tfi').applyOptions({
      scaleMargins: { top: 0.72, bottom: 0.26 },
      borderVisible: false,
      visible: false,
    });

    this._initMicroChart();

    this._partialLinesPrimitive = new PartialPriceLinesPrimitive();
    this.candleSeries.attachPrimitive(this._partialLinesPrimitive);

    this.chart.timeScale().subscribeVisibleLogicalRangeChange((lr) => {
      this._maybeRequestHistory(lr);
    });

    this._resizeObs = new ResizeObserver(() => this._handleResize());
    this._resizeObs.observe(container);

    document.getElementById('toggle-ema').addEventListener('change', (e) => {
      this.showEma = e.target.checked;
      storeIndicatorOn(CHART_SHOW_EMA_STORAGE_KEY, this.showEma);
      this._toggleEma(this.showEma);
    });
    document.getElementById('toggle-supertrend').addEventListener('change', (e) => {
      this.showSupertrend = e.target.checked;
      storeIndicatorOn(CHART_SHOW_ST_STORAGE_KEY, this.showSupertrend);
      this.stSeries.applyOptions({ visible: this.showSupertrend });
    });

    const emaEl = document.getElementById('toggle-ema');
    if (emaEl instanceof HTMLInputElement) emaEl.checked = this.showEma;
    const stEl = document.getElementById('toggle-supertrend');
    if (stEl instanceof HTMLInputElement) stEl.checked = this.showSupertrend;
    this._toggleEma(this.showEma);
    this.stSeries.applyOptions({ visible: this.showSupertrend });

    const ctWrap = document.getElementById('candle-theme-wrap');
    const ctTrigger = document.getElementById('candle-theme-trigger');
    const ctMenu = document.getElementById('candle-theme-menu');
    if (ctWrap && ctTrigger && ctMenu) {
      ctMenu.replaceChildren(
        ...CANDLE_THEMES.map((th) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'candle-theme-option';
          b.setAttribute('role', 'option');
          b.setAttribute('data-theme-id', th.id);
          b.textContent = th.label;
          return b;
        }),
      );
      this._syncCandleThemeDropdown(initialTheme.id);
      ctTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ctMenu.hidden) this._openCandleThemeMenu();
        else this._closeCandleThemeMenu();
      });
      ctMenu.addEventListener('click', (e) => {
        const opt = e.target.closest('[data-theme-id]');
        if (!opt || !ctMenu.contains(opt)) return;
        const id = opt.getAttribute('data-theme-id');
        if (!id) return;
        this._applyCandleTheme(id, { persist: true });
        this._closeCandleThemeMenu();
      });
    }

    const smcToggle = document.getElementById('toggle-smc-overlay');
    if (smcToggle instanceof HTMLInputElement) {
      smcToggle.checked = this._smcSignalsOverlayEnabled;
      smcToggle.addEventListener('change', () => {
        this._smcSignalsOverlayEnabled = smcToggle.checked;
        this._storeSmcOverlayEnabled(this._smcSignalsOverlayEnabled);
        this._paintSmcFromStoredSignals();
      });
    }

    const hudToggle = document.getElementById('toggle-signal-hud');
    if (hudToggle instanceof HTMLInputElement) {
      hudToggle.checked = this._signalHudEnabled;
      hudToggle.addEventListener('change', () => {
        this._signalHudEnabled = hudToggle.checked;
        storeSignalHudEnabled(this._signalHudEnabled);
        this.updateStrategyHud(this._lastSignalsForChart);
      });
    }

    const knnToggle = document.getElementById('toggle-knn-overlay');
    if (knnToggle instanceof HTMLInputElement) {
      knnToggle.checked = this._knnArchitectureEnabled;
      knnToggle.addEventListener('change', () => {
        this._knnArchitectureEnabled = knnToggle.checked;
        this._storeKnnArchitectureEnabled(this._knnArchitectureEnabled);
        this._paintSmcFromStoredSignals();
      });
    }

    const liqToggle = document.getElementById('toggle-liquidations');
    if (liqToggle instanceof HTMLInputElement) {
      liqToggle.checked = this._liquidationsEnabled;
      liqToggle.addEventListener('change', () => {
        this._liquidationsEnabled = liqToggle.checked;
        storeIndicatorOn(LIQUIDATION_MARKERS_STORAGE_KEY, this._liquidationsEnabled);
        this._paintAllMarkers();
      });
    }

    const oiToggle = document.getElementById('toggle-oi-regime');
    if (oiToggle instanceof HTMLInputElement) {
      oiToggle.checked = this._oiRegimeEnabled;
      oiToggle.addEventListener('change', () => {
        this._oiRegimeEnabled = oiToggle.checked;
        storeIndicatorOn(OI_REGIME_STORAGE_KEY, this._oiRegimeEnabled);
        this._syncOiRegimeOverlay();
      });
    }

    const vwapToggle = document.getElementById('toggle-vwap');
    if (vwapToggle instanceof HTMLInputElement) {
      vwapToggle.checked = this._vwapEnabled;
      vwapToggle.addEventListener('change', () => {
        this._vwapEnabled = vwapToggle.checked;
        storeIndicatorOn(VWAP_STORAGE_KEY, this._vwapEnabled);
        this._vwapSeries.applyOptions({ visible: this._vwapEnabled });
        if (this._vwapEnabled) this._paintVwap(this.currentTf);
      });
    }

    const rsiToggle = document.getElementById('toggle-rsi');
    if (rsiToggle instanceof HTMLInputElement) {
      rsiToggle.checked = this._rsiEnabled;
      rsiToggle.addEventListener('change', () => {
        this._rsiEnabled = rsiToggle.checked;
        storeIndicatorOn(RSI_STORAGE_KEY, this._rsiEnabled);
        this._rsiSeries.applyOptions({ visible: this._rsiEnabled });
        this.chart.priceScale('rsi').applyOptions({ visible: this._rsiEnabled });
        if (this._rsiEnabled) this._paintIndicators(this.currentTf);
      });
    }

    const spreadToggle = document.getElementById('toggle-spread-heatmap');
    if (spreadToggle instanceof HTMLInputElement) {
      spreadToggle.checked = this._spreadHeatmapEnabled;
      spreadToggle.addEventListener('change', () => {
        this._spreadHeatmapEnabled = spreadToggle.checked;
        storeIndicatorOn(SPREAD_HEATMAP_STORAGE_KEY, this._spreadHeatmapEnabled);
      });
    }

    const tfiToggle = document.getElementById('toggle-tfi');
    if (tfiToggle instanceof HTMLInputElement) {
      tfiToggle.checked = this._tfiEnabled;
      tfiToggle.addEventListener('change', () => {
        this._tfiEnabled = tfiToggle.checked;
        storeIndicatorOn(TFI_STORAGE_KEY, this._tfiEnabled);
        this._tfiSeries.applyOptions({ visible: this._tfiEnabled });
      });
    }

    const dpToggle = document.getElementById('toggle-depth-pressure');
    if (dpToggle instanceof HTMLInputElement) {
      dpToggle.checked = this._depthPressureEnabled;
      dpToggle.addEventListener('change', () => {
        this._depthPressureEnabled = dpToggle.checked;
        storeIndicatorOn(DEPTH_PRESSURE_STORAGE_KEY, this._depthPressureEnabled);
        if (!this._depthPressureEnabled) this._partialLinesPrimitive?.removeLine('dp-zone');
        else this._syncDepthPressureZones();
      });
    }

    const obiToggle = document.getElementById('toggle-obi-tint');
    if (obiToggle instanceof HTMLInputElement) {
      obiToggle.checked = this._obiTintEnabled;
      obiToggle.addEventListener('change', () => {
        this._obiTintEnabled = obiToggle.checked;
        storeIndicatorOn(OBI_TINT_STORAGE_KEY, this._obiTintEnabled);
        if (!this._obiTintEnabled) this._restoreDefaultWickColors();
        else this._syncObiTint();
      });
    }

    const microToggle = document.getElementById('toggle-micro');
    if (microToggle instanceof HTMLInputElement) {
      microToggle.checked = this._microEnabled;
      microToggle.addEventListener('change', () => {
        this._microEnabled = microToggle.checked;
        storeIndicatorOn(MICRO_CHART_STORAGE_KEY, this._microEnabled);
        const mc = document.getElementById('micro-chart-container');
        if (mc) mc.style.display = this._microEnabled ? '' : 'none';
        if (this._microEnabled) this._initMicroChart();
        if (this._microChart) this._microChart.applyOptions({ width: mc?.clientWidth ?? 0 });
      });
    }

    const signalHudEl = document.getElementById('chart-signal-hud');
    if (signalHudEl) {
      signalHudEl.addEventListener('toggle', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLDetailsElement)) return;
        if (!t.classList.contains('chart-signal-hud-more')) return;
        storeSignalHudDetailsOpen(t.open);
      });
    }

    const bookTopToggle = document.getElementById('toggle-book-top');
    if (bookTopToggle instanceof HTMLInputElement) {
      bookTopToggle.checked = this._bookTopLinesEnabled;
      bookTopToggle.addEventListener('change', () => {
        this._bookTopLinesEnabled = bookTopToggle.checked;
        storeBookTopLinesEnabled(this._bookTopLinesEnabled);
        this._syncBookTopLines();
      });
    }

    document.querySelectorAll('.tf-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tf === this.currentTf);
    });

    document.querySelectorAll('.tf-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tf-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        if (this._historyDebounceTimer != null) {
          clearTimeout(this._historyDebounceTimer);
          this._historyDebounceTimer = null;
        }
        const alignToVisibleTimeRange = this._getSafeVisibleTimeRange();
        this.currentTf = btn.dataset.tf;
        storeChartTf(this.currentTf);
        this._clearSmcChartVisuals();
        this._loadTf(this.currentTf, { alignToVisibleTimeRange });
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
    this._vwapSeries?.setData([]);
    this._rsiSeries?.setData([]);
    this._tfiSeries?.setData([]);
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
      color: this._volumeBarColor(c),
    }));
    this.candleSeries.setData(bars);
    this.volumeSeries.setData(vols);
    this._resetVolumeAnimState();
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
    const mc = document.getElementById('micro-chart-container');
    if (mc && this._microChart) this._microChart.applyOptions({ width: mc.clientWidth });
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

  _isAnomalousRange(arr, row) {
    if (arr.length < 20) return false;
    const tail = arr.slice(-20);
    const ranges = tail.map((c) => Math.abs(c.high - c.low)).sort((a, b) => a - b);
    const median = ranges[Math.floor(ranges.length / 2)];
    if (median <= 0) return false;
    const incoming = Math.abs(row.high - row.low);
    if (incoming > median * 8) {
      console.warn('[chart] rejected anomalous bar', { tf: this.currentTf, openTime: row.openTime, range: incoming, median });
      return true;
    }
    return false;
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
    // Preserve current zoom level across timeframe switches. 
    // If not set (initial boot), default to 4.
    const currentSpacing = this.chart ? this.chart.timeScale().options().barSpacing : 4;
    const ts = {
      ...CHART_OPTS.timeScale,
      timeVisible: !dailyLike,
      secondsVisible: false,
      /** Extra empty space so the last candle is not drawn under stacked price-scale labels. */
      rightOffset: 22,
      barSpacing: currentSpacing,
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
    // Just snap to the latest data respecting the rightOffset gap.
    // Do not use fitContent() or setVisibleLogicalRange(), as they stretch/shrink the candles.
    this.chart.timeScale().scrollToRealTime();
  }

  /**
   * LW `Time` can be UTCTimestamp (sec) or BusinessDay — normalize for `setVisibleRange`.
   * @param {unknown} t
   * @returns {number}
   */
  _horzTimeToUnixSec(t) {
    if (t == null) return NaN;
    if (typeof t === 'number' && Number.isFinite(t)) return t;
    if (typeof t === 'string') {
      const n = Number(t);
      return Number.isFinite(n) ? n : NaN;
    }
    if (typeof t === 'object' && t !== null && 'year' in t && 'month' in t && 'day' in t) {
      const y = /** @type {{ year: number; month: number; day: number }} */ (t).year;
      const mo = /** @type {{ year: number; month: number; day: number }} */ (t).month;
      const d = /** @type {{ year: number; month: number; day: number }} */ (t).day;
      if ([y, mo, d].every(Number.isFinite)) return Math.floor(Date.UTC(y, mo - 1, d) / 1000);
    }
    return NaN;
  }

  /**
   * Visible chart window in unix seconds (for cross-TF zoom continuity).
   * @returns {{ from: number; to: number } | null}
   */
  _getSafeVisibleTimeRange() {
    if (!this.chart) return null;
    try {
      const r = this.chart.timeScale().getVisibleRange();
      if (!r) return null;
      const from = this._horzTimeToUnixSec(r.from);
      const to = this._horzTimeToUnixSec(r.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      if (hi <= lo) return null;
      return { from: lo, to: hi };
    } catch {
      return null;
    }
  }

  /** Ingest snapshot (initial load) */
  onSnapshot({ candles, indicators, availableTimeframes }) {
    this._historyExhausted = {};
    this._historyLoading = {};
    this.set24hHighLow(null, null);
    this._liquidationMarkers = [];
    this._lastMarkPrice = null;
    this._lastFunding = null;
    this._oiRegime = null;
    this._tfiBarMap?.clear();
    this._lastDepthPressure = null;
    this._currentObi = null;
    this._microCandleSeries?.setData([]);
    if (this._oiRegimePriceLine && this.candleSeries) {
      try { this.candleSeries.removePriceLine(this._oiRegimePriceLine); } catch { /* ignore */ }
      this._oiRegimePriceLine = null;
    }
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
      storeChartTf(next);
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
    if (this._isAnomalousRange(arr, row)) return;

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
      this._loadTf(tf, { preserveVisibleRange: true });
      return;
    }

    const t = Math.floor(tail.openTime / 1000);
    if (!Number.isFinite(t)) return;
    if (![tail.open, tail.high, tail.low, tail.close].every(Number.isFinite)) return;
    const sameBar = prevLastOpenTime != null && tail.openTime === prevLastOpenTime;
    const vol = tail.volume;
    const volColor = this._volumeBarColor(tail);
    this._setFormingBarCtxFromQuote(tail);
    try {
      if (sameBar) {
        this._smoothVolumeTo(t, vol, volColor);
      } else {
        this._snapVolumeDisplay(t, vol, volColor);
      }
      if (sameBar) this._smoothLtpTo(tail.close);
      else this._snapLtpTo(tail.close);
      this._refreshFormingCandleFromCtx();
    } catch (e) {
      console.warn('[chart] candle update failed, resyncing series', e);
      this._loadTf(tf, { preserveVisibleRange: true });
    }
  }

  onIndicators(indicators) {
    this.indicMap = { ...this.indicMap, ...indicators };
    this._paintIndicators(this.currentTf);
  }

  /**
   * @param {string} tf
   * @param {{
   *   preserveVisibleRange?: boolean;
   *   alignToVisibleTimeRange?: { from: number; to: number } | null;
   * }} [opts] — `preserveVisibleRange`: same logical bar indices after `setData` (resync / theme).
   *   `alignToVisibleTimeRange`: keep the same unix time window (used when switching TFs).
   */
  _loadTf(tf, opts = {}) {
    const preserveVisibleRange = opts.preserveVisibleRange === true;
    const alignToVisibleTimeRange = opts.alignToVisibleTimeRange ?? null;
    /** Logical bar indices before `setData` — reapplied after paint so zoom is not wiped. */
    let savedLogicalRange = null;
    if (preserveVisibleRange && this.chart && tf === this.currentTf) {
      try {
        savedLogicalRange = this.chart.timeScale().getVisibleLogicalRange();
      } catch {
        savedLogicalRange = null;
      }
    }

    const raw = this.candleMap[tf];
    this._applyTimeScaleForTf(tf);

    if (!raw || raw.length === 0) {
      this._resetVolumeAnimState();
      this.candleSeries.setData([]);
      this.volumeSeries.setData([]);
      this._clearOverlaySeries();
      this._partialLinesPrimitive?.clear();
      this._openPositionLines.clear();
      this._positionMarkers = [];
      if (this._oiRegimePriceLine && this.candleSeries) {
        try { this.candleSeries.removePriceLine(this._oiRegimePriceLine); } catch { /* ignore */ }
        this._oiRegimePriceLine = null;
      }
      if (this._fundingPriceLine && this.candleSeries) {
        try { this.candleSeries.removePriceLine(this._fundingPriceLine); } catch { /* ignore */ }
        this._fundingPriceLine = null;
      }
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
      color: this._volumeBarColor(c),
    }));

    this.candleSeries.setData(bars);
    this.volumeSeries.setData(vols);
    this._resetVolumeAnimState();

    this._paintIndicators(tf);

    const canAlignTime =
      alignToVisibleTimeRange &&
      Number.isFinite(alignToVisibleTimeRange.from) &&
      Number.isFinite(alignToVisibleTimeRange.to) &&
      alignToVisibleTimeRange.to > alignToVisibleTimeRange.from;

    if (canAlignTime) {
      try {
        this.chart.timeScale().setVisibleRange({
          from: alignToVisibleTimeRange.from,
          to: alignToVisibleTimeRange.to,
        });
      } catch (e) {
        console.warn('[chart] setVisibleRange after TF change', e);
        this._fitDefaultVisibleRange(tf, candles.length);
      }
    } else if (
      preserveVisibleRange &&
      savedLogicalRange &&
      savedLogicalRange.from != null &&
      savedLogicalRange.to != null &&
      Number.isFinite(savedLogicalRange.from) &&
      Number.isFinite(savedLogicalRange.to)
    ) {
      try {
        this.chart.timeScale().setVisibleLogicalRange(savedLogicalRange);
      } catch {
        this._fitDefaultVisibleRange(tf, candles.length);
      }
    } else {
      this._fitDefaultVisibleRange(tf, candles.length);
    }
    this._setFormingBarCtxFromQuote(candles[candles.length - 1] ?? null);
    const lastClose = candles[candles.length - 1]?.close;
    this._snapLtpTo(Number.isFinite(lastClose) ? lastClose : NaN);
    this._paintSmcFromStoredSignals();
    this._sync24hLines();
    this._syncBookTopLines();
    this._syncMarkLine();
    this._syncOiRegimeOverlay();
    this._syncFundingOverlay();
    this._tfiBarMap.clear();
    this._tfiSeries?.setData([]);
    this._syncDepthPressureZones();
  }

  _computeSessionVwap(candles) {
    const result = [];
    let cumPV = 0;
    let cumV = 0;
    let sessionDay = -1;
    for (const c of candles) {
      const d = new Date(c.openTime);
      const day = d.getUTCDate() + d.getUTCMonth() * 100 + d.getUTCFullYear() * 10000;
      if (day !== sessionDay) {
        cumPV = 0;
        cumV = 0;
        sessionDay = day;
      }
      const tp = (c.high + c.low + c.close) / 3;
      cumPV += tp * c.volume;
      cumV += c.volume;
      if (cumV > 0) {
        result.push({ time: Math.floor(c.openTime / 1000), value: cumPV / cumV });
      }
    }
    return result;
  }

  _paintVwap(tf) {
    if (!this._vwapSeries || !this._vwapEnabled) return;
    const raw = this.candleMap[tf];
    if (!raw?.length) {
      this._vwapSeries.setData([]);
      return;
    }
    const candles = this._sortedDedupeCandles(raw);
    this._vwapSeries.setData(this._computeSessionVwap(candles));
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

    if (ind.rsi && this._rsiEnabled) {
      const rsiData = toLine(ind.rsi);
      this._rsiSeries.setData(this._padLineLikeToLastTime(rsiData, tLastCandle));
    } else if (this._rsiSeries) {
      this._rsiSeries.setData([]);
    }

    this._paintVwap(tf);
  }
}
