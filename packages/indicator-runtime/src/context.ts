// ExecutionContext binds builtin series (open/high/low/close/volume/hl2/hlc3/ohlc4),
// holds user-assigned series, owns the per-bar quota counters, and collects emitted
// outputs (plots/shapes/hlines/bgcolors).

import { Series, DEFAULT_SERIES_CAPACITY } from './series';
import { QuotaError, RuntimeError } from './errors';

const BUILTIN_SERIES_NAMES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4'] as const;

const TF_DURATION_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
};

export function tfDurationMs(tf: string): number {
  return TF_DURATION_MS[tf] || 0;
}

export interface CandleLike {
  openTime?: number;
  time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StrategyMarker {
  time: number | null;
  position?: string;
  color?: string;
  shape?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ClosedTrade {
  side: string;
  entryPrice: number;
  exitPrice: number;
  entryBar: number;
  exitBar: number;
  qty: number;
  pnl: number;
  ret: number;
  reason: string;
}

export interface StrategyPosition {
  side: 'long' | 'short';
  entryPrice: number;
  entryBar: number;
  qty: number;
}

export interface StrategyState {
  initialCapital: number;
  position: StrategyPosition | null;
  trades: ClosedTrade[];
  equity: number[];
  equityTimes: (number | null)[];
  markersBar: StrategyMarker[];
  markersAll: StrategyMarker[];
}

export interface PlotSeriesOutput {
  name: string;
  kind: 'line' | 'histogram' | 'area';
  opts: Record<string, unknown>;
  values: number[];
  times: (number | null)[];
}

export interface MarkerSeriesOutput {
  name: string;
  kind: 'marker';
  opts: Record<string, unknown>;
  markers: StrategyMarker[];
}

export interface HLineOutput {
  name: string;
  kind: 'hline';
  price: number;
  opts: Record<string, unknown>;
}

export interface BgColorSegment {
  time: number | null;
  color: string | null;
  opacity?: number;
  [key: string]: unknown;
}

export interface BgColorOutput {
  name: string;
  kind: 'bgcolor';
  opts: Record<string, unknown>;
  segments: BgColorSegment[];
}

export interface AlertEvent {
  time: number | null;
  message: string;
  bar: number;
}

export interface AlertOutput {
  name: string;
  kind: 'alert';
  opts: Record<string, unknown>;
  events: AlertEvent[];
}

export type RuntimeOutput =
  | PlotSeriesOutput
  | MarkerSeriesOutput
  | HLineOutput
  | BgColorOutput
  | AlertOutput;

export interface StrategyStats {
  initialCapital: number;
  finalEquity: number;
  totalPnl: number;
  totalReturn: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  openPosition: {
    side: string;
    entryPrice: number;
    entryBar: number;
    qty: number;
  } | null;
}

const DEFAULTS = {
  nodeBudgetPerBar: 10_000,
  liveBarBudgetMs: 5,
  fullHistoryBudgetMs: 250,
  seriesCapacity: DEFAULT_SERIES_CAPACITY,
};

export interface CreateContextOptions {
  nodeBudgetPerBar?: number;
  liveBarBudgetMs?: number;
  fullHistoryBudgetMs?: number;
  seriesCapacity?: number;
}

export interface HtfSeriesBundle {
  openTimes: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  hl2: Float64Array;
  hlc3: Float64Array;
  ohlc4: Float64Array;
}

export type BuiltinSeriesKey = (typeof BUILTIN_SERIES_NAMES)[number];

export interface ExecutionContext {
  capacity: number;
  nodeBudgetPerBar: number;
  liveBarBudgetMs: number;
  fullHistoryBudgetMs: number;
  builtins: Record<BuiltinSeriesKey, Series>;
  userSeries: Map<string, Series>;
  inputs: Map<string, unknown>;
  callState: WeakMap<object, unknown>;
  nodeBudgetRemaining: number;
  meta: { name: string | null; opts: Record<string, unknown>; kind: 'indicator' | 'strategy' };
  strategy: StrategyState | null;
  outputs: Map<string, RuntimeOutput>;
  barEmissions: unknown[];
  times: (number | null)[] | null;
  barIndex: number;
  htfData: Map<string, HtfSeriesBundle>;
  resetForBar(barIndex: number): void;
  tickNodeBudget(): void;
  pushBar(candle: CandleLike): void;
  resolve(name: string): Series | unknown | undefined;
  assign(name: string, value: unknown): Series;
  setInput(name: string, value: unknown): void;
  emitPlot(
    node: { line?: number; col?: number },
    kind: 'line' | 'histogram' | 'area',
    value: number,
    opts: Record<string, unknown>,
  ): void;
  loadHtfData(byTf: Record<string, CandleLike[] | undefined> | null | undefined): void;
  lookupHtfValue(tf: string, srcName: string): number;
  initStrategy(opts: Record<string, unknown>): void;
  strategyOrder(side: 'long' | 'short' | 'flat', condition: boolean, opts?: Record<string, unknown>): void;
  _closePosition(price: number, time: number | null, opts?: Record<string, unknown>): void;
  tickStrategyBar(): void;
  strategyStats(): StrategyStats | null;
  emitAlert(node: { line?: number; col?: number }, message: string, opts: Record<string, unknown>): void;
  emitShape(node: { line?: number; col?: number }, cond: boolean, opts: Record<string, unknown>): void;
  emitHLine(node: { line?: number; col?: number }, price: number, opts: Record<string, unknown>): void;
  emitBgColor(
    node: { line?: number; col?: number },
    color: string | null,
    opts: Record<string, unknown>,
  ): void;
  snapshotOutputs(): SerializedScriptOutput[];
  snapshotDelta(prevSnapshot: Map<string, { markers?: number; events?: number }> | undefined): DeltaOutput[];
  snapshotCounts(): Map<string, { markers?: number; events?: number }>;
}

export interface SerializedPoint {
  time: number | null;
  value: number;
}

export type SerializedScriptOutput =
  | {
      name: string;
      kind: 'line' | 'histogram' | 'area';
      opts: Record<string, unknown>;
      data: SerializedPoint[];
    }
  | { name: string; kind: 'marker'; opts: Record<string, unknown>; markers: StrategyMarker[] }
  | { name: string; kind: 'hline'; opts: Record<string, unknown>; price: number }
  | { name: string; kind: 'bgcolor'; opts: Record<string, unknown>; segments: BgColorSegment[] }
  | { name: string; kind: 'alert'; opts: Record<string, unknown>; events: AlertEvent[] }
  | { name: string; kind: 'stats'; opts: Record<string, unknown>; stats: StrategyStats; trades: ClosedTrade[] };

export type DeltaOutput =
  | { name: string; kind: 'line' | 'histogram' | 'area'; point: SerializedPoint }
  | { name: string; kind: 'marker'; markers: StrategyMarker[] }
  | { name: string; kind: 'hline'; price: number }
  | { name: string; kind: 'bgcolor'; segment: BgColorSegment }
  | { name: string; kind: 'alert'; events: AlertEvent[] }
  | { name: string; kind: 'stats'; stats: StrategyStats | null; trades: ClosedTrade[] };

export function createContext(opts: CreateContextOptions = {}): ExecutionContext {
  const capacity = opts.seriesCapacity ?? DEFAULTS.seriesCapacity;
  const builtins = Object.fromEntries(
    BUILTIN_SERIES_NAMES.map((name) => [name, new Series(capacity)]),
  ) as Record<BuiltinSeriesKey, Series>;

  const ctx: ExecutionContext = {
    capacity,
    nodeBudgetPerBar: opts.nodeBudgetPerBar ?? DEFAULTS.nodeBudgetPerBar,
    liveBarBudgetMs: opts.liveBarBudgetMs ?? DEFAULTS.liveBarBudgetMs,
    fullHistoryBudgetMs: opts.fullHistoryBudgetMs ?? DEFAULTS.fullHistoryBudgetMs,

    builtins,

    userSeries: new Map(),
    inputs: new Map(),
    callState: new WeakMap(),
    nodeBudgetRemaining: 0,

    meta: { name: null, opts: {}, kind: 'indicator' },
    strategy: null,
    outputs: new Map(),
    barEmissions: [],
    times: null,
    barIndex: -1,
    htfData: new Map(),

    resetForBar(barIndex: number) {
      this.barIndex = barIndex;
      this.nodeBudgetRemaining = this.nodeBudgetPerBar;
      this.barEmissions = [];
    },

    tickNodeBudget() {
      this.nodeBudgetRemaining -= 1;
      if (this.nodeBudgetRemaining < 0) {
        throw new QuotaError(`Per-bar AST node budget exhausted (${this.nodeBudgetPerBar})`, {
          barIndex: this.barIndex,
        });
      }
    },

    pushBar(candle: CandleLike) {
      const { open, high, low, close, volume } = candle;
      this.builtins.open.push(open);
      this.builtins.high.push(high);
      this.builtins.low.push(low);
      this.builtins.close.push(close);
      this.builtins.volume.push(volume);
      this.builtins.hl2.push((high + low) / 2);
      this.builtins.hlc3.push((high + low + close) / 3);
      this.builtins.ohlc4.push((open + high + low + close) / 4);
    },

    resolve(name: string) {
      if (name in this.builtins) return this.builtins[name as BuiltinSeriesKey];
      if (this.userSeries.has(name)) return this.userSeries.get(name);
      if (this.inputs.has(name)) return this.inputs.get(name);
      return undefined;
    },

    assign(name: string, value: unknown) {
      let s = this.userSeries.get(name);
      if (!s) {
        s = new Series(this.capacity);
        this.userSeries.set(name, s);
      }
      const num =
        typeof value === 'number'
          ? value
          : value === true
            ? 1
            : value === false
              ? 0
              : value instanceof Series
                ? value.get(0)
                : NaN;
      s.push(num);
      return s;
    },

    setInput(name: string, value: unknown) {
      this.inputs.set(name, value);
    },

    emitPlot(node, kind, value, opts) {
      const outName = (opts.title as string | undefined) || `plot_${nodeKey(node)}`;
      let out = this.outputs.get(outName) as PlotSeriesOutput | undefined;
      if (!out) {
        out = {
          name: outName,
          kind,
          opts: { ...opts },
          values: [],
          times: [],
        };
        this.outputs.set(outName, out);
      } else if (!sameOpts(out.opts, opts)) {
        out.opts = { ...out.opts, ...opts };
      }
      const t = this.times ? this.times[this.barIndex]! : null;
      out.values.push(value);
      out.times.push(t);
    },

    loadHtfData(byTf) {
      this.htfData.clear();
      if (!byTf || typeof byTf !== 'object') return;
      for (const [tf, candles] of Object.entries(byTf)) {
        if (!Array.isArray(candles) || candles.length === 0) continue;
        const sorted = candles
          .filter((c) => c && Number.isFinite(c.openTime))
          .slice()
          .sort((a, b) => (a.openTime ?? 0) - (b.openTime ?? 0));
        const dedup: CandleLike[] = [];
        let lastOt = -1;
        for (const c of sorted) {
          const ot = c.openTime ?? 0;
          if (ot === lastOt) {
            dedup[dedup.length - 1] = c;
          } else {
            dedup.push(c);
            lastOt = ot;
          }
        }
        const n = dedup.length;
        const times = new Float64Array(n);
        const opens = new Float64Array(n);
        const highs = new Float64Array(n);
        const lows = new Float64Array(n);
        const closes = new Float64Array(n);
        const volumes = new Float64Array(n);
        const hl2 = new Float64Array(n);
        const hlc3 = new Float64Array(n);
        const ohlc4 = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const c = dedup[i]!;
          times[i] = c.openTime ?? 0;
          opens[i] = c.open;
          highs[i] = c.high;
          lows[i] = c.low;
          closes[i] = c.close;
          volumes[i] = c.volume;
          hl2[i] = (c.high + c.low) / 2;
          hlc3[i] = (c.high + c.low + c.close) / 3;
          ohlc4[i] = (c.open + c.high + c.low + c.close) / 4;
        }
        this.htfData.set(tf, {
          openTimes: times,
          open: opens,
          high: highs,
          low: lows,
          close: closes,
          volume: volumes,
          hl2,
          hlc3,
          ohlc4,
        });
      }
    },

    lookupHtfValue(tf: string, srcName: string): number {
      const data = this.htfData.get(tf);
      if (!data) return NaN;
      const arr = data[srcName as keyof HtfSeriesBundle] as Float64Array | undefined;
      if (!arr || !(arr instanceof Float64Array)) return NaN;
      const currentTimeSec = this.times ? this.times[this.barIndex] : null;
      if (!Number.isFinite(currentTimeSec)) return NaN;
      const currentTimeMs = Number(currentTimeSec) * 1000;
      const durMs = tfDurationMs(tf);
      if (durMs <= 0) return NaN;
      const ot = data.openTimes;
      let lo = 0;
      let hi = ot.length - 1;
      let foundIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ot[mid]! + durMs <= currentTimeMs) {
          foundIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (foundIdx < 0) return NaN;
      return arr[foundIdx]!;
    },

    initStrategy(opts) {
      const initialCapital = Number(opts?.initial_capital);
      this.strategy = {
        initialCapital: Number.isFinite(initialCapital) && initialCapital > 0 ? initialCapital : 10_000,
        position: null,
        trades: [],
        equity: [],
        equityTimes: [],
        markersBar: [],
        markersAll: [],
      };
    },

    strategyOrder(side, condition, opts) {
      if (this.meta.kind !== 'strategy' || !this.strategy) {
        throw new RuntimeError('entry()/exit() may only be called from a strategy(...) script', {
          barIndex: this.barIndex,
        });
      }
      if (!condition) return;
      const close = this.builtins.close.get(0);
      if (!Number.isFinite(close)) return;
      const s = this.strategy;
      const t = this.times ? this.times[this.barIndex]! : null;
      if (side === 'flat') {
        if (!s.position) return;
        this._closePosition(close, t, opts);
        return;
      }
      if (s.position && s.position.side !== side) {
        this._closePosition(close, t, { reason: 'reverse' });
      }
      if (s.position && s.position.side === side) return;
      const qty = Math.max(0, Number(opts?.qty) || 1);
      s.position = { side, entryPrice: close, entryBar: this.barIndex, qty };
      s.markersBar.push({
        time: t,
        position: side === 'long' ? 'belowBar' : 'aboveBar',
        color: side === 'long' ? '#26a69a' : '#ef5350',
        shape: side === 'long' ? 'arrowUp' : 'arrowDown',
        text: side === 'long' ? 'L' : 'S',
      });
    },

    _closePosition(price: number, time: number | null, opts?: Record<string, unknown>) {
      const s = this.strategy!;
      if (!s.position) return;
      const pnl =
        s.position.side === 'long'
          ? (price - s.position.entryPrice) * s.position.qty
          : (s.position.entryPrice - price) * s.position.qty;
      const ret =
        s.position.entryPrice === 0 ? 0 : pnl / (s.position.entryPrice * s.position.qty);
      s.trades.push({
        side: s.position.side,
        entryPrice: s.position.entryPrice,
        exitPrice: price,
        entryBar: s.position.entryBar,
        exitBar: this.barIndex,
        qty: s.position.qty,
        pnl,
        ret,
        reason: (opts?.reason as string) || 'exit',
      });
      s.markersBar.push({
        time,
        position: 'aboveBar',
        color: pnl >= 0 ? '#9ccc65' : '#ef5350',
        shape: 'circle',
        text: pnl >= 0 ? 'X+' : 'X-',
      });
      s.position = null;
    },

    tickStrategyBar() {
      const s = this.strategy;
      if (!s) return;
      const close = this.builtins.close.get(0);
      let realized = 0;
      for (const t of s.trades) realized += t.pnl;
      let unrealized = 0;
      if (s.position && Number.isFinite(close)) {
        unrealized =
          s.position.side === 'long'
            ? (close - s.position.entryPrice) * s.position.qty
            : (s.position.entryPrice - close) * s.position.qty;
      }
      const t = this.times ? this.times[this.barIndex]! : null;
      s.equity.push(s.initialCapital + realized + unrealized);
      s.equityTimes.push(t);
      if (s.markersBar.length) {
        for (const m of s.markersBar) s.markersAll.push(m);
        s.markersBar = [];
      }
    },

    strategyStats() {
      const s = this.strategy;
      if (!s) return null;
      const trades = s.trades.length;
      let wins = 0;
      let losses = 0;
      let winSum = 0;
      let lossSum = 0;
      for (const t of s.trades) {
        if (t.pnl > 0) {
          wins += 1;
          winSum += t.pnl;
        } else if (t.pnl < 0) {
          losses += 1;
          lossSum += t.pnl;
        }
      }
      const totalPnl = winSum + lossSum;
      const finalEquity = s.equity.length ? s.equity[s.equity.length - 1]! : s.initialCapital;
      const totalReturn = (finalEquity - s.initialCapital) / s.initialCapital;
      let peak = s.initialCapital;
      let maxDD = 0;
      for (const eq of s.equity) {
        if (eq > peak) peak = eq;
        const dd = peak > 0 ? (peak - eq) / peak : 0;
        if (dd > maxDD) maxDD = dd;
      }
      const openPos = s.position
        ? {
            side: s.position.side,
            entryPrice: s.position.entryPrice,
            entryBar: s.position.entryBar,
            qty: s.position.qty,
          }
        : null;
      return {
        initialCapital: s.initialCapital,
        finalEquity,
        totalPnl,
        totalReturn,
        trades,
        wins,
        losses,
        winRate: trades > 0 ? wins / trades : 0,
        avgWin: wins > 0 ? winSum / wins : 0,
        avgLoss: losses > 0 ? lossSum / losses : 0,
        maxDrawdown: maxDD,
        openPosition: openPos,
      };
    },

    emitAlert(node, message, opts) {
      const outName = `alert_${nodeKey(node)}`;
      let out = this.outputs.get(outName) as AlertOutput | undefined;
      if (!out) {
        out = { name: outName, kind: 'alert', opts: { ...opts }, events: [] };
        this.outputs.set(outName, out);
      }
      const t = this.times ? this.times[this.barIndex]! : null;
      out.events.push({ time: t, message, bar: this.barIndex });
    },

    emitShape(node, cond, opts) {
      if (!cond) return;
      const outName = (opts.title as string | undefined) || `shape_${nodeKey(node)}`;
      let out = this.outputs.get(outName) as MarkerSeriesOutput | undefined;
      if (!out) {
        out = { name: outName, kind: 'marker', opts: { ...opts }, markers: [] };
        this.outputs.set(outName, out);
      }
      const t = this.times ? this.times[this.barIndex]! : null;
      out.markers.push({ time: t, ...opts });
    },

    emitHLine(node, price, opts) {
      const outName = (opts.title as string | undefined) || `hline_${nodeKey(node)}`;
      this.outputs.set(outName, { name: outName, kind: 'hline', price, opts: { ...opts } });
    },

    emitBgColor(node, color, opts) {
      const outName = `bgcolor_${nodeKey(node)}`;
      let out = this.outputs.get(outName) as BgColorOutput | undefined;
      if (!out) {
        out = { name: outName, kind: 'bgcolor', opts: { ...opts }, segments: [] };
        this.outputs.set(outName, out);
      }
      const t = this.times ? this.times[this.barIndex]! : null;
      out.segments.push({ time: t, color, ...opts });
    },

    snapshotOutputs(): SerializedScriptOutput[] {
      const out: SerializedScriptOutput[] = [];
      for (const o of this.outputs.values()) {
        if (o.kind === 'line' || o.kind === 'histogram' || o.kind === 'area') {
          const po = o as PlotSeriesOutput;
          out.push({
            name: po.name,
            kind: po.kind,
            opts: po.opts,
            data: po.values.map((v, i) => ({ time: po.times[i]!, value: v })),
          });
        } else if (o.kind === 'marker') {
          const mo = o as MarkerSeriesOutput;
          out.push({ name: mo.name, kind: 'marker', opts: mo.opts, markers: mo.markers });
        } else if (o.kind === 'hline') {
          const ho = o as HLineOutput;
          out.push({ name: ho.name, kind: 'hline', opts: ho.opts, price: ho.price });
        } else if (o.kind === 'bgcolor') {
          const bo = o as BgColorOutput;
          out.push({ name: bo.name, kind: 'bgcolor', opts: bo.opts, segments: bo.segments });
        } else if (o.kind === 'alert') {
          const ao = o as AlertOutput;
          out.push({ name: ao.name, kind: 'alert', opts: ao.opts, events: ao.events });
        }
      }
      if (this.meta.kind === 'strategy' && this.strategy) {
        const strat = this.strategy;
        const eqData = strat.equity.map((v, i) => ({
          time: strat.equityTimes[i]!,
          value: v,
        }));
        out.push({
          name: '__strategy_equity',
          kind: 'line',
          opts: { color: '#42a5f5', lineWidth: 1.5, pane: 1, title: 'Equity' },
          data: eqData,
        });
        out.push({
          name: '__strategy_markers',
          kind: 'marker',
          opts: {},
          markers: this.strategy.markersAll,
        });
        out.push({
          name: '__strategy_stats',
          kind: 'stats',
          opts: {},
          stats: this.strategyStats()!,
          trades: this.strategy.trades,
        });
      }
      return out;
    },

    snapshotDelta(prevSnapshot): DeltaOutput[] {
      const deltas: DeltaOutput[] = [];
      const t = this.times ? this.times[this.barIndex]! : null;
      if (this.meta.kind === 'strategy' && this.strategy) {
        const lastEq = this.strategy.equity[this.strategy.equity.length - 1];
        if (Number.isFinite(lastEq)) {
          deltas.push({ name: '__strategy_equity', kind: 'line', point: { time: t, value: lastEq! } });
        }
        const prevMarkers = prevSnapshot?.get('__strategy_markers')?.markers ?? 0;
        const totalMarkers = this.strategy.markersAll.length;
        if (totalMarkers > prevMarkers) {
          deltas.push({
            name: '__strategy_markers',
            kind: 'marker',
            markers: this.strategy.markersAll.slice(prevMarkers),
          });
        }
        deltas.push({
          name: '__strategy_stats',
          kind: 'stats',
          stats: this.strategyStats(),
          trades: this.strategy.trades,
        });
      }
      for (const o of this.outputs.values()) {
        if (o.kind === 'line' || o.kind === 'histogram' || o.kind === 'area') {
          const po = o as PlotSeriesOutput;
          const last = po.values[po.values.length - 1];
          deltas.push({ name: po.name, kind: po.kind, point: { time: t, value: last! } });
        } else if (o.kind === 'marker') {
          const mo = o as MarkerSeriesOutput;
          const prev = prevSnapshot?.get(mo.name)?.markers ?? 0;
          const next = mo.markers.length;
          if (next > prev) {
            deltas.push({
              name: mo.name,
              kind: 'marker',
              markers: mo.markers.slice(prev),
            });
          }
        } else if (o.kind === 'hline') {
          const ho = o as HLineOutput;
          deltas.push({ name: ho.name, kind: 'hline', price: ho.price });
        } else if (o.kind === 'bgcolor') {
          const bo = o as BgColorOutput;
          const lastSeg = bo.segments[bo.segments.length - 1];
          deltas.push({ name: bo.name, kind: 'bgcolor', segment: lastSeg! });
        } else if (o.kind === 'alert') {
          const ao = o as AlertOutput;
          const prev = prevSnapshot?.get(ao.name)?.events ?? 0;
          const next = ao.events.length;
          if (next > prev) {
            deltas.push({
              name: ao.name,
              kind: 'alert',
              events: ao.events.slice(prev),
            });
          }
        }
      }
      return deltas;
    },

    snapshotCounts() {
      const m = new Map<string, { markers?: number; events?: number }>();
      for (const o of this.outputs.values()) {
        if (o.kind === 'marker') m.set(o.name, { markers: (o as MarkerSeriesOutput).markers.length });
        else if (o.kind === 'alert') m.set(o.name, { events: (o as AlertOutput).events.length });
      }
      if (this.meta.kind === 'strategy' && this.strategy) {
        m.set('__strategy_markers', { markers: this.strategy.markersAll.length });
      }
      return m;
    },
  };

  return ctx;
}

function nodeKey(node: { line?: number; col?: number }): string {
  return `${node.line ?? 0}_${node.col ?? 0}`;
}

function sameOpts(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
