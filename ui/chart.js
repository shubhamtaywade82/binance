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
  fmtLtpDisplay,
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
    /** Best bid / ask from order book — horizontal guides on the price scale. */
    this._bookTopBidLine = null;
    this._bookTopAskLine = null;
    this._lastBookBid = null;
    this._lastBookAsk = null;
    this._bookTopLinesEnabled = readBookTopLinesEnabled();
    /** @type {(() => void) | null} */
    this._candleThemeDocCloseUnsub = null;
    /** Horizontal SMC / ref levels (not the LTP line). */
    this._smcSignalPriceLines = [];
    /** Shaded OB / FVG zones (LWC series primitive). */
    this._smcZonePrimitive = null;
    this._smcSignalsOverlayEnabled = this._readSmcOverlayEnabled();
    /** Latest WS `signals` payload for redraw after `setData`. */
    this._lastSignalsForChart = null;
    this._signalHudEnabled = readSignalHudEnabled();
    this.showEma = readStoredIndicatorOn(CHART_SHOW_EMA_STORAGE_KEY, true);
    this.showSupertrend = readStoredIndicatorOn(CHART_SHOW_ST_STORAGE_KEY, true);
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
    try {
      this.candleSeries?.setMarkers([]);
    } catch {
      /* ignore */
    }
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
    if (!this._smcSignalsOverlayEnabled || !this._lastSignalsForChart || !this.candleSeries) return;
    const s = this._lastSignalsForChart;
    const refTf = s.refPriceTf;
    if (typeof refTf !== 'string' || refTf !== this.currentTf) return;

    const smc = s.smc;
    if (!smc) return;

    const markers = [];
    /** @type {{ t1: number; t2: number; top: number; bottom: number; fill: string; stroke?: string; text?: string; textColor?: string }[]} */
    const smcZones = [];
    /** @type {{ t1: number; t2: number; price: number; color: string; label?: string; lineWidth?: number }[]} */
    const smcStructLines = [];
    const lastT = this._lastVisibleBarTimeSec(refTf);

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
            const alpha = ob.isMitigated ? 0.05 : (isInst ? 0.35 : 0.20);
            const strokeAlpha = ob.isMitigated ? 0.2 : 0.6;
            
            smcZones.push({
              t1: tOb,
              t2: lastT,
              top: ob.high,
              bottom: ob.low,
              fill: bull 
                ? `rgba(38,166,154,${alpha})` 
                : `rgba(239,83,80,${alpha})`,
              stroke: bull 
                ? `rgba(38,166,154,${strokeAlpha})` 
                : `rgba(239,83,80,${strokeAlpha})`,
              text: (isInst ? 'Inst. ' : '') + (bull ? 'Demand' : 'Supply') + (ob.isMitigated ? ' (Mit)' : ''),
              textColor: bull ? 'rgba(200,255,240,0.8)' : 'rgba(255,220,220,0.8)',
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
          const bull = fvg.type === 'BULLISH';
          const isHighValue = fvg.score >= 2;
          const alpha = isHighValue ? 0.22 : 0.12;
          
          smcZones.push({
            t1: tFvg,
            t2: lastT,
            top: fvg.high,
            bottom: fvg.low,
            fill: `rgba(255,193,7,${alpha})`, 
            stroke: `rgba(255,193,7,${isHighValue ? 0.5 : 0.3})`,
            text: isHighValue ? 'Propulsion FVG' : 'FVG',
            textColor: 'rgba(255,236,179,0.7)',
          });
        }
      }
    }

    // 3. Dealing Range (Premium / Discount)
    if (smc.dealingRange && lastT != null) {
      const dr = smc.dealingRange;
      const startT = lastT - 3600 * 4; 
      smcZones.push({
        t1: startT,
        t2: lastT,
        top: dr.high,
        bottom: dr.equilibrium,
        fill: 'rgba(239,83,80,0.03)',
        text: 'PREMIUM',
        textColor: 'rgba(239,83,80,0.3)',
      });
      smcZones.push({
        t1: startT,
        t2: lastT,
        top: dr.equilibrium,
        bottom: dr.low,
        fill: 'rgba(38,166,154,0.03)',
        text: 'DISCOUNT',
        textColor: 'rgba(38,166,154,0.3)',
      });
      // Equilibrium Line
      smcStructLines.push({
        t1: startT,
        t2: lastT,
        price: dr.equilibrium,
        color: 'rgba(176,190,197,0.4)',
        label: 'EQ',
        lineWidth: 1,
      });
    }

    // 4. Breaker Blocks
    if (Array.isArray(smc.breakers)) {
      for (const bb of smc.breakers) {
        const tBb = this._signalBarTimeSec(refTf, bb.index);
        if (tBb != null && lastT != null) {
          const bull = bb.type === 'BULLISH';
          smcZones.push({
            t1: tBb,
            t2: lastT,
            top: bb.high,
            bottom: bb.low,
            fill: bull ? 'rgba(126,87,194,0.15)' : 'rgba(126,87,194,0.15)', 
            stroke: 'rgba(126,87,194,0.4)',
            text: bull ? 'Bull Breaker' : 'Bear Breaker',
            textColor: 'rgba(209,196,233,0.8)',
          });
        }
      }
    }

    // 5. Generic Blocks (Liquidity, Sessions, etc.)
    if (Array.isArray(smc.blocks)) {
      for (const blk of smc.blocks) {
        const t1 = this._signalBarTimeSec(refTf, blk.startIndex);
        const t2 = this._signalBarTimeSec(refTf, blk.endIndex) || lastT;
        if (t1 != null && t2 != null) {
          let fill = 'rgba(144,164,174,0.1)';
          let stroke = 'rgba(144,164,174,0.3)';
          let textColor = 'rgba(207,216,220,0.8)';
          
          if (blk.type === 'LIQUIDITY') {
            fill = 'rgba(0,188,212,0.15)'; 
            stroke = 'rgba(0,188,212,0.4)';
            textColor = 'rgba(178,235,242,0.8)';
          } else if (blk.type === 'SESSION') {
            fill = 'rgba(100,181,246,0.05)'; 
            stroke = 'rgba(100,181,246,0.2)';
            textColor = 'rgba(187,222,251,0.5)';
          }
          
          smcZones.push({
            t1, t2, top: blk.high, bottom: blk.low,
            fill, stroke, text: blk.subType, textColor
          });
        }
      }
    }

    if (lastT != null) {
      if (smc.bos && smc.bos !== 'NONE') {
        const bull = smc.bos === 'BULLISH';
        const tBos = smc.bosLine && Number.isFinite(smc.bosLine.endIndex) 
          ? this._signalBarTimeSec(refTf, smc.bosLine.endIndex) 
          : null;
        markers.push({
          time: tBos ?? lastT,
          position: 'aboveBar',
          shape: bull ? 'arrowUp' : 'arrowDown',
          color: '#b388ff',
          text: 'BOS',
          id: 'smc-bos',
        });
      }
      if (smc.choch && smc.choch !== 'NONE') {
        const bull = smc.choch === 'BULLISH';
        const tChoch = smc.chochLine && Number.isFinite(smc.chochLine.endIndex) 
          ? this._signalBarTimeSec(refTf, smc.chochLine.endIndex) 
          : null;
        markers.push({
          time: tChoch ?? lastT,
          position: 'belowBar',
          shape: bull ? 'arrowUp' : 'arrowDown',
          color: '#80cbc4',
          text: 'CHoCH',
          id: 'smc-choch',
        });
      }

      // 1. Swing dots
      if (Array.isArray(smc.swings)) {
        for (const sw of smc.swings) {
          const tSw = this._signalBarTimeSec(refTf, sw.index);
          if (!tSw) continue;
          markers.push({
            time: tSw,
            position: sw.kind === 'high' ? 'aboveBar' : 'belowBar',
            shape: 'circle',
            color: sw.kind === 'high' ? 'rgba(255,82,82,0.3)' : 'rgba(0,230,118,0.3)',
            size: 0.2, // Smaller, more subtle markers
          });
        }
      }

      // 2. Structural Labels (HH, HL, LH, LL)
      if (Array.isArray(smc.structPoints)) {
        for (const sp of smc.structPoints) {
          const tSp = this._signalBarTimeSec(refTf, sp.swing.index);
          if (!tSp) continue;
          const isHigh = sp.swing.kind === 'high';
          markers.push({
            time: tSp,
            position: isHigh ? 'aboveBar' : 'belowBar',
            shape: 'circle', // Minimal shape to focus on the text label
            color: isHigh ? '#ff5252' : '#00e676',
            text: sp.label.toUpperCase(),
            size: 0.1, // Near zero size to "remove" the icon
          });
        }
      }
      let hasLiqSweepMarker = false;
      const liq = smc.liquidity;
      if (liq && typeof liq === 'object') {
        const pools = Array.isArray(liq.pools) ? liq.pools : [];
        let liqLines = 0;
        for (const p of pools) {
          if (liqLines >= 4) break;
          const px = p.price;
          if (!Number.isFinite(px)) continue;
          const bullPool = p.kind === 'buyside' || p.kind === 'BUYSIDE';
          this._addSmcPriceLine(
            px,
            bullPool ? 'rgba(255,128,171,0.5)' : 'rgba(128,203,255,0.5)',
            bullPool ? 'LQ↑' : 'LQ↓',
            LineStyle.Dotted,
          );
          liqLines++;
        }
        const pr = liq.primaryRejection;
        if (
          pr &&
          pr.outcome === 'rejection' &&
          pr.sweepBarIndex != null &&
          Number.isFinite(pr.sweepBarIndex)
        ) {
          const tSweep = this._signalBarTimeSec(refTf, pr.sweepBarIndex);
          if (tSweep != null) {
            const buyRaid = pr.poolKind === 'buyside' || pr.poolKind === 'BUYSIDE';
            const raidArrow = pr.raidDirection === 'DOWN' ? '↓' : '↑';
            markers.push({
              time: tSweep,
              position: buyRaid ? 'aboveBar' : 'belowBar',
              shape: buyRaid ? 'arrowDown' : 'arrowUp',
              color: '#ff80ab',
              text: `LQ${raidArrow}${Number(pr.score) || 0}`,
            });
            hasLiqSweepMarker = true;
          }
        }
      }
      if (smc.liquiditySweep && smc.liquiditySweep !== 'NONE' && !hasLiqSweepMarker) {
        markers.push({
          time: lastT,
          position: 'inBar',
          shape: 'circle',
          color: '#ff80ab',
          text: 'LS',
        });
      }
    }

    const bosLinePayload = smc.bosLine;
    const chochLinePayload = smc.chochLine;
    const bosActive = smc.bos && smc.bos !== 'NONE';
    const chochActive = smc.choch && smc.choch !== 'NONE';
    const sameBosChochGeometry =
      bosActive &&
      chochActive &&
      bosLinePayload &&
      chochLinePayload &&
      bosLinePayload.startIndex === chochLinePayload.startIndex &&
      bosLinePayload.endIndex === chochLinePayload.endIndex &&
      Math.abs(bosLinePayload.price - chochLinePayload.price) < 1e-10;

    const pushSmcStructureSegment = (line, color, label, position) => {
      if (!line || !Number.isFinite(line.price)) return;
      const tA = this._signalBarTimeSec(refTf, line.startIndex);
      const tB = this._signalBarTimeSec(refTf, line.endIndex) ?? lastT;
      if (tA == null || tB == null) return;
      const t1 = Math.min(tA, tB);
      const t2 = Math.max(tA, tB);
      if (t2 <= t1) return;
      smcStructLines.push({ t1, t2, price: line.price, color, label, position, lineWidth: 2 });
    };

    if (sameBosChochGeometry && bosLinePayload) {
      pushSmcStructureSegment(bosLinePayload, '#a389d4', 'BOS · CHoCH', smc.bos === 'BULLISH' ? 'top' : 'bottom');
    } else {
      if (bosActive) pushSmcStructureSegment(bosLinePayload, '#b388ff', 'BOS', smc.bos === 'BULLISH' ? 'top' : 'bottom');
      if (chochActive) pushSmcStructureSegment(chochLinePayload, '#80cbc4', 'CHoCH', smc.choch === 'BULLISH' ? 'top' : 'bottom');
    }

    if (Number.isFinite(s.refPrice)) {
      this._addSmcPriceLine(s.refPrice, 'rgba(184,134,255,0.9)', 'REF', LineStyle.Dotted);
    }

    this._smcZonePrimitive?.setZones(smcZones);
    this._smcZonePrimitive?.setLines(smcStructLines);

    if (markers.length) {
      markers.sort((a, b) => a.time - b.time);
      try {
        this.candleSeries.setMarkers(markers);
      } catch (e) {
        console.warn('[chart] SMC markers', e);
      }
    }
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
    if (!up || !down) return candleRow.close >= candleRow.open ? 'rgba(0,230,118,0.35)' : 'rgba(255,23,68,0.35)';
    return candleRow.close >= candleRow.open ? up : down;
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

  _removeBookTopLines() {
    if (this.candleSeries && this._bookTopBidLine) {
      try {
        this.candleSeries.removePriceLine(this._bookTopBidLine);
      } catch {
        /* ignore */
      }
    }
    if (this.candleSeries && this._bookTopAskLine) {
      try {
        this.candleSeries.removePriceLine(this._bookTopAskLine);
      } catch {
        /* ignore */
      }
    }
    this._bookTopBidLine = null;
    this._bookTopAskLine = null;
  }

  _ensureBookTopLines() {
    if (!this.candleSeries) return;
    if (!this._bookTopBidLine) {
      this._bookTopBidLine = this.candleSeries.createPriceLine({
        price: this._lastBookBid ?? 0,
        color: 'rgba(0,230,118,0.82)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lineVisible: true,
        axisLabelVisible: true,
        title: 'BID',
        axisLabelColor: 'rgba(0,230,118,0.95)',
        axisLabelTextColor: '#e8f5e9',
      });
    }
    if (!this._bookTopAskLine) {
      this._bookTopAskLine = this.candleSeries.createPriceLine({
        price: this._lastBookAsk ?? 0,
        color: 'rgba(255,23,68,0.82)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lineVisible: true,
        axisLabelVisible: true,
        title: 'ASK',
        axisLabelColor: 'rgba(255,23,68,0.95)',
        axisLabelTextColor: '#ffebee',
      });
    }
  }

  _syncBookTopLines() {
    if (!this.candleSeries) return;
    if (!this._bookTopLinesEnabled) {
      this._removeBookTopLines();
      return;
    }
    const bid = this._lastBookBid;
    const ask = this._lastBookAsk;
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid > ask) {
      this._removeBookTopLines();
      return;
    }
    this._ensureBookTopLines();
    this._bookTopBidLine?.applyOptions({
      price: bid,
      lineVisible: true,
      axisLabelVisible: true,
      title: 'BID',
      color: 'rgba(0,230,118,0.82)',
      axisLabelColor: 'rgba(0,230,118,0.95)',
      axisLabelTextColor: '#e8f5e9',
    });
    this._bookTopAskLine?.applyOptions({
      price: ask,
      lineVisible: true,
      axisLabelVisible: true,
      title: 'ASK',
      color: 'rgba(255,23,68,0.82)',
      axisLabelColor: 'rgba(255,23,68,0.95)',
      axisLabelTextColor: '#ffebee',
    });
  }

  /**
   * Best bid / ask from the order book (same top-of-book as the ladder). Non-finite clears lines.
   */
  setBookTopLevels(bid, ask) {
    const b = Number.isFinite(bid) ? bid : null;
    const a = Number.isFinite(ask) ? ask : null;
    if (b == null || a == null) {
      this._lastBookBid = null;
      this._lastBookAsk = null;
      this._removeBookTopLines();
      return;
    }
    this._lastBookBid = b;
    this._lastBookAsk = a;
    this._syncBookTopLines();
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
        if (this._smcSignalsOverlayEnabled) this._paintSmcFromStoredSignals();
        else this._clearSmcChartVisuals();
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
  }
}
