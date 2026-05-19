import type { Candle, ProviderClient } from '../provider-client';
import type { SerializedScriptOutput } from '@chart-studio/indicator-runtime';
import { loadScripts, saveScripts, ScriptRunner, type SavedScript } from './runner';
import type { ChartView } from '../chart';
import type { SeriesMarker, UTCTimestamp, ISeriesApi, LineWidth } from 'lightweight-charts';

interface Mounted {
  scriptId: string;
  lineSeries: ISeriesApi<'Line'>[];
  histogramSeries: ISeriesApi<'Histogram'>[];
}

/**
 * NanoPine script editor + executor. Compiles each script in a worker,
 * draws plots onto the main chart, and renders markers via setMarkers.
 */
export class ScriptManager {
  private overlay: HTMLElement;
  private scripts: SavedScript[] = loadScripts();
  private runner = new ScriptRunner();
  private mounted = new Map<string, Mounted>();
  private candles: Candle[] = [];
  private activeId: string | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly chart: ChartView,
    _client: ProviderClient,
  ) {
    this.overlay = this.ensureOverlay();
    document.getElementById('scripts-btn')?.addEventListener('click', () => this.open());
    this.overlay.querySelector('#close-scripts')?.addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
    this.activeId = this.scripts[0]?.id ?? null;
  }

  /** Called when the chart loads a new history. */
  setCandles(candles: Candle[]): void {
    this.candles = candles;
    void this.runEnabled();
  }

  /** Called on each candle update. We re-run enabled scripts (cheap enough for the user's bar count). */
  updateCandle(_c: Candle, candles: Candle[]): void {
    this.candles = candles;
    void this.runEnabled();
  }

  private async runEnabled(): Promise<void> {
    if (this.candles.length === 0) return;
    const allMarkers: SeriesMarker<UTCTimestamp>[] = [];
    for (const s of this.scripts) {
      if (!s.enabled) {
        const mounted = this.mounted.get(s.id);
        if (mounted) this.unmount(mounted);
        this.mounted.delete(s.id);
        continue;
      }
      const result = await this.runner.run(s, this.candles).catch((err) => ({ ok: false as const, error: String(err), reqId: 's' }));
      if (!result.ok) {
        this.setStatus(s.id, `error: ${result.error}`);
        continue;
      }
      this.setStatus(s.id, 'ok');
      this.applyOutputs(s.id, result.outputs ?? [], allMarkers);
    }
    this.chart.setMarkers(allMarkers);
  }

  private applyOutputs(scriptId: string, outputs: SerializedScriptOutput[], markersAccum: SeriesMarker<UTCTimestamp>[]): void {
    let mounted = this.mounted.get(scriptId);
    if (!mounted) { mounted = { scriptId, lineSeries: [], histogramSeries: [] }; this.mounted.set(scriptId, mounted); }

    // Detach existing series; we'll rebuild fresh.
    this.unmount(mounted);
    mounted.lineSeries = [];
    mounted.histogramSeries = [];

    const chartApi = this.chart.api();
    for (const out of outputs) {
      if (out.kind === 'line' || out.kind === 'area' || out.kind === 'histogram') {
        const color = (out.opts['color'] as string) ?? '#58a6ff';
        if (out.kind === 'histogram') {
          const s = chartApi.addHistogramSeries({ color });
          s.setData(out.data.filter((p) => p.time !== null && Number.isFinite(p.value)).map((p) => ({
            time: ((p.time as number) / 1000) as UTCTimestamp,
            value: p.value,
            color,
          })));
          mounted.histogramSeries.push(s);
        } else {
          const s = chartApi.addLineSeries({ color, lineWidth: 1 as LineWidth, priceLineVisible: false, lastValueVisible: false });
          s.setData(out.data.filter((p) => p.time !== null && Number.isFinite(p.value)).map((p) => ({
            time: ((p.time as number) / 1000) as UTCTimestamp,
            value: p.value,
          })));
          mounted.lineSeries.push(s);
        }
      } else if (out.kind === 'marker') {
        for (const m of out.markers) {
          if (typeof m.time !== 'number') continue;
          markersAccum.push({
            time: (m.time / 1000) as UTCTimestamp,
            position: (m.position as SeriesMarker<UTCTimestamp>['position']) ?? 'aboveBar',
            color: (m.color as string) ?? '#58a6ff',
            shape: (m.shape as SeriesMarker<UTCTimestamp>['shape']) ?? 'circle',
            text: (m.text as string) ?? '',
          });
        }
      }
    }
  }

  private unmount(mounted: Mounted): void {
    const api = this.chart.api();
    for (const s of mounted.lineSeries) { try { api.removeSeries(s); } catch { /* noop */ } }
    for (const s of mounted.histogramSeries) { try { api.removeSeries(s); } catch { /* noop */ } }
  }

  private open(): void {
    this.render();
    this.overlay.classList.remove('hidden');
  }

  private close(): void {
    this.overlay.classList.add('hidden');
  }

  private setStatus(scriptId: string, msg: string): void {
    const el = this.overlay.querySelector<HTMLElement>(`[data-status="${scriptId}"]`);
    if (el) el.textContent = msg;
    for (const fn of this.listeners) fn();
  }

  private ensureOverlay(): HTMLElement {
    let el = document.getElementById('scripts-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'scripts-overlay';
    el.className = 'overlay hidden';
    el.innerHTML = `
      <div class="settings-modal scripts-modal">
        <h2>NanoPine Scripts</h2>
        <p class="hint">Bar-by-bar indicator/strategy runtime. Plots render directly on the chart.</p>
        <div class="scripts-layout">
          <aside class="scripts-list" id="scripts-list"></aside>
          <section class="scripts-edit">
            <input id="script-name" type="text" placeholder="Script name" />
            <textarea id="script-source" spellcheck="false"></textarea>
            <div class="scripts-actions">
              <button class="ghost" id="script-new">+ New</button>
              <button class="ghost" id="script-save">Save</button>
              <button class="ghost" id="script-run">Run</button>
              <label><input type="checkbox" id="script-enabled"/> Enabled (auto-render on chart)</label>
              <span id="script-status" class="alert-fired"></span>
            </div>
          </section>
        </div>
        <button class="ghost" id="close-scripts">Close</button>
      </div>`;
    document.body.appendChild(el);

    el.querySelector('#script-new')?.addEventListener('click', () => {
      const id = `s${Date.now().toString(36)}`;
      this.scripts.push({ id, name: 'Untitled', source: '// new script\n', enabled: false });
      saveScripts(this.scripts);
      this.activeId = id;
      this.render();
    });
    el.querySelector('#script-save')?.addEventListener('click', () => this.saveActive());
    el.querySelector('#script-run')?.addEventListener('click', () => { this.saveActive(); void this.runEnabled(); });
    el.querySelector<HTMLInputElement>('#script-enabled')?.addEventListener('change', (ev) => {
      const checked = (ev.target as HTMLInputElement).checked;
      const a = this.scripts.find((x) => x.id === this.activeId);
      if (!a) return;
      a.enabled = checked;
      saveScripts(this.scripts);
      void this.runEnabled();
    });
    return el;
  }

  private saveActive(): void {
    const a = this.scripts.find((x) => x.id === this.activeId);
    if (!a) return;
    const name = (this.overlay.querySelector<HTMLInputElement>('#script-name')?.value ?? '').trim();
    const source = this.overlay.querySelector<HTMLTextAreaElement>('#script-source')?.value ?? '';
    a.name = name || a.name;
    a.source = source;
    saveScripts(this.scripts);
    this.render();
  }

  private render(): void {
    const list = this.overlay.querySelector('#scripts-list')!;
    list.innerHTML = this.scripts.map((s) => `
      <div class="script-item ${s.id === this.activeId ? 'active' : ''}" data-id="${s.id}">
        <span>${escape(s.name)}</span>
        <span class="alert-fired" data-status="${s.id}">${s.enabled ? 'enabled' : 'paused'}</span>
      </div>
    `).join('');
    list.querySelectorAll<HTMLElement>('.script-item').forEach((el) => {
      el.addEventListener('click', () => { this.activeId = el.dataset.id!; this.render(); });
    });
    const active = this.scripts.find((s) => s.id === this.activeId);
    const nameInput = this.overlay.querySelector<HTMLInputElement>('#script-name');
    const sourceInput = this.overlay.querySelector<HTMLTextAreaElement>('#script-source');
    const enabledInput = this.overlay.querySelector<HTMLInputElement>('#script-enabled');
    if (nameInput) nameInput.value = active?.name ?? '';
    if (sourceInput) sourceInput.value = active?.source ?? '';
    if (enabledInput) enabledInput.checked = !!active?.enabled;
  }
}

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
