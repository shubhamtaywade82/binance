import type { IPriceLine, ISeriesApi, UTCTimestamp, LineWidth } from 'lightweight-charts';
import { LineStyle } from 'lightweight-charts';
import type { ChartView } from '../chart';

const STORAGE_KEY = 'chart-studio:drawings:v1';

export type DrawingTool = 'cursor' | 'hline' | 'trendline';

export interface HLineDrawing {
  id: string;
  kind: 'hline';
  price: number;
  color: string;
}

export interface TrendLineDrawing {
  id: string;
  kind: 'trendline';
  t1: UTCTimestamp;
  p1: number;
  t2: UTCTimestamp;
  p2: number;
  color: string;
}

export type Drawing = HLineDrawing | TrendLineDrawing;

interface StoredDrawings { [providerSymbol: string]: Drawing[] }

const loadStore = (): StoredDrawings => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'); } catch { return {}; }
};
const persistStore = (s: StoredDrawings): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* noop */ }
};

const idGen = (): string => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Drawing layer. v1 supports:
 *  - horizontal price lines (via createPriceLine on the main series)
 *  - trend lines (via line series with two anchor points)
 *
 * Persists per (provider, symbol) in localStorage.
 */
export class DrawingLayer {
  private currentKey: string | null = null;
  private drawings: Drawing[] = [];
  private tool: DrawingTool = 'cursor';
  private store: StoredDrawings = loadStore();
  private hlineHandles = new Map<string, IPriceLine>();
  private trendlineHandles = new Map<string, ISeriesApi<'Line'>>();
  private pendingPoint: { t: UTCTimestamp; p: number } | null = null;
  private toolListeners = new Set<(t: DrawingTool) => void>();

  constructor(private readonly chart: ChartView, private readonly container: HTMLElement) {
    container.addEventListener('click', (ev) => this.handleClick(ev));
  }

  setTool(tool: DrawingTool): void {
    this.tool = tool;
    this.pendingPoint = null;
    this.container.style.cursor = tool === 'cursor' ? '' : 'crosshair';
    for (const fn of this.toolListeners) fn(tool);
  }

  currentTool(): DrawingTool { return this.tool; }

  onToolChange(fn: (t: DrawingTool) => void): () => void {
    this.toolListeners.add(fn);
    return () => { this.toolListeners.delete(fn); };
  }

  setSymbol(provider: string, symbol: string): void {
    this.clearMounted();
    this.currentKey = `${provider}:${symbol}`;
    this.drawings = this.store[this.currentKey] ?? [];
    this.mountAll();
  }

  list(): Drawing[] { return this.drawings; }

  remove(id: string): void {
    this.drawings = this.drawings.filter((d) => d.id !== id);
    const main = this.chart.mainSeries();
    const hh = this.hlineHandles.get(id);
    if (hh) { try { main.removePriceLine(hh); } catch { /* noop */ } this.hlineHandles.delete(id); }
    const th = this.trendlineHandles.get(id);
    if (th) { try { this.chart.api().removeSeries(th); } catch { /* noop */ } this.trendlineHandles.delete(id); }
    this.persist();
  }

  clear(): void {
    for (const d of [...this.drawings]) this.remove(d.id);
  }

  private clearMounted(): void {
    const main = this.chart.mainSeries();
    for (const h of this.hlineHandles.values()) { try { main.removePriceLine(h); } catch { /* noop */ } }
    for (const s of this.trendlineHandles.values()) { try { this.chart.api().removeSeries(s); } catch { /* noop */ } }
    this.hlineHandles.clear();
    this.trendlineHandles.clear();
  }

  private mountAll(): void {
    for (const d of this.drawings) this.mount(d);
  }

  private mount(d: Drawing): void {
    if (d.kind === 'hline') {
      const handle = this.chart.mainSeries().createPriceLine({
        price: d.price, color: d.color, lineStyle: LineStyle.Dashed, lineWidth: 1 as LineWidth, axisLabelVisible: true, title: '',
      });
      this.hlineHandles.set(d.id, handle);
    } else if (d.kind === 'trendline') {
      const s = this.chart.api().addLineSeries({ color: d.color, lineWidth: 2 as LineWidth, lastValueVisible: false, priceLineVisible: false });
      const p1 = { time: d.t1, value: d.p1 };
      const p2 = { time: d.t2, value: d.p2 };
      const ordered = (p1.time as number) <= (p2.time as number) ? [p1, p2] : [p2, p1];
      s.setData(ordered);
      this.trendlineHandles.set(d.id, s);
    }
  }

  private handleClick(ev: MouseEvent): void {
    if (this.tool === 'cursor') return;
    const rect = this.container.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const time = this.chart.xToTime(x);
    const price = this.chart.yToPrice(y);
    if (typeof price !== 'number' || time === null) return;
    if (this.tool === 'hline') {
      const d: HLineDrawing = { id: idGen(), kind: 'hline', price, color: '#f0b400' };
      this.drawings.push(d);
      this.mount(d);
      this.persist();
      this.setTool('cursor');
      return;
    }
    if (this.tool === 'trendline') {
      if (!this.pendingPoint) {
        this.pendingPoint = { t: time, p: price };
        return;
      }
      const d: TrendLineDrawing = {
        id: idGen(), kind: 'trendline', color: '#58a6ff',
        t1: this.pendingPoint.t, p1: this.pendingPoint.p, t2: time, p2: price,
      };
      this.drawings.push(d);
      this.mount(d);
      this.pendingPoint = null;
      this.persist();
      this.setTool('cursor');
    }
  }

  private persist(): void {
    if (!this.currentKey) return;
    this.store[this.currentKey] = this.drawings;
    persistStore(this.store);
  }
}
