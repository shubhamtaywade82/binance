import type { Candle } from '../provider-client';
import { bollinger, ema, macd, rsi, vwap } from './math';

export type Pane = 'overlay' | 'rsi' | 'macd';

export interface SeriesSpec {
  label: string;
  color: string;
  values: number[];
  pane: Pane;
  /** "line" | "histogram". */
  kind?: 'line' | 'histogram';
  /** lightweight-charts price-scale id when not overlay. */
  priceScaleId?: string;
}

export interface IndicatorDef {
  id: string;
  label: string;
  /** Defaults shown in the configure dialog. */
  defaults: Record<string, number>;
  compute(candles: Candle[], params: Record<string, number>): SeriesSpec[];
}

const closes = (c: Candle[]): number[] => c.map((x) => x.close);

export const INDICATORS: IndicatorDef[] = [
  {
    id: 'ema',
    label: 'EMA',
    defaults: { period: 21 },
    compute(c, p) {
      const v = ema(closes(c), Math.max(1, Math.round(p.period ?? 21)));
      return [{ label: `EMA ${p.period}`, color: '#58a6ff', values: v, pane: 'overlay' }];
    },
  },
  {
    id: 'ema-multi',
    label: 'EMA 9/21/50',
    defaults: {},
    compute(c) {
      const v = closes(c);
      return [
        { label: 'EMA 9', color: '#f0b400', values: ema(v, 9), pane: 'overlay' },
        { label: 'EMA 21', color: '#58a6ff', values: ema(v, 21), pane: 'overlay' },
        { label: 'EMA 50', color: '#bc8cff', values: ema(v, 50), pane: 'overlay' },
      ];
    },
  },
  {
    id: 'bollinger',
    label: 'Bollinger Bands',
    defaults: { period: 20, mult: 2 },
    compute(c, p) {
      const bb = bollinger(closes(c), Math.round(p.period ?? 20), p.mult ?? 2);
      return [
        { label: 'BB upper', color: '#8b949e', values: bb.upper, pane: 'overlay' },
        { label: 'BB mid',   color: '#f0b400', values: bb.middle, pane: 'overlay' },
        { label: 'BB lower', color: '#8b949e', values: bb.lower, pane: 'overlay' },
      ];
    },
  },
  {
    id: 'vwap',
    label: 'Session VWAP',
    defaults: {},
    compute(c) {
      return [{ label: 'VWAP', color: '#3fb950', values: vwap(c), pane: 'overlay' }];
    },
  },
  {
    id: 'rsi',
    label: 'RSI',
    defaults: { period: 14 },
    compute(c, p) {
      return [{ label: `RSI ${p.period ?? 14}`, color: '#bc8cff', values: rsi(closes(c), Math.round(p.period ?? 14)), pane: 'rsi', priceScaleId: 'rsi' }];
    },
  },
  {
    id: 'macd',
    label: 'MACD',
    defaults: { fast: 12, slow: 26, signal: 9 },
    compute(c, p) {
      const m = macd(closes(c), Math.round(p.fast ?? 12), Math.round(p.slow ?? 26), Math.round(p.signal ?? 9));
      return [
        { label: 'MACD',   color: '#58a6ff', values: m.macd,   pane: 'macd', priceScaleId: 'macd' },
        { label: 'signal', color: '#f0b400', values: m.signal, pane: 'macd', priceScaleId: 'macd' },
        { label: 'hist',   color: '#3fb950', values: m.hist,   pane: 'macd', priceScaleId: 'macd', kind: 'histogram' },
      ];
    },
  },
];

export interface ActiveIndicator {
  /** Instance id (uuid-ish) so multiple copies can coexist. */
  uid: string;
  defId: string;
  params: Record<string, number>;
}

const STORAGE_KEY = 'chart-studio:indicators:v1';

export const loadActiveIndicators = (): ActiveIndicator[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [{ uid: 'default-ema', defId: 'ema-multi', params: {} }];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x.defId === 'string');
  } catch {
    return [];
  }
};

export const saveActiveIndicators = (list: ActiveIndicator[]): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* ignore */ }
};
