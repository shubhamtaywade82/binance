import { INDICATORS, loadActiveIndicators, saveActiveIndicators, type ActiveIndicator } from './registry';

export class IndicatorPicker {
  private overlay: HTMLElement;
  private list: HTMLElement;
  private active: ActiveIndicator[] = loadActiveIndicators();
  private listeners = new Set<(list: ActiveIndicator[]) => void>();

  constructor() {
    this.overlay = this.ensureOverlay();
    this.list = this.overlay.querySelector('#indicator-active-list') as HTMLElement;

    document.getElementById('indicators-btn')?.addEventListener('click', () => this.open());
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });
    this.overlay.querySelector('#close-indicators')?.addEventListener('click', () => this.close());
    this.overlay.querySelector('#indicator-add')?.addEventListener('change', (e) => {
      const sel = e.target as HTMLSelectElement;
      const defId = sel.value;
      if (!defId) return;
      const def = INDICATORS.find((d) => d.id === defId);
      if (!def) return;
      const uid = `${defId}-${Date.now().toString(36)}`;
      this.active.push({ uid, defId, params: { ...def.defaults } });
      sel.value = '';
      this.persistAndRender();
    });
  }

  onChange(fn: (list: ActiveIndicator[]) => void): () => void {
    this.listeners.add(fn);
    fn(this.active);
    return () => { this.listeners.delete(fn); };
  }

  current(): ActiveIndicator[] {
    return this.active;
  }

  open(): void {
    this.renderActive();
    this.overlay.classList.remove('hidden');
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  private persistAndRender(): void {
    saveActiveIndicators(this.active);
    this.renderActive();
    for (const fn of this.listeners) fn(this.active);
  }

  private ensureOverlay(): HTMLElement {
    let el = document.getElementById('indicators-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'indicators-overlay';
    el.className = 'overlay hidden';
    const options = INDICATORS.map((d) => `<option value="${d.id}">${d.label}</option>`).join('');
    el.innerHTML = `
      <div class="settings-modal" style="width: 520px;">
        <h2>Indicators</h2>
        <p class="hint">Toggle and configure indicators. Persisted to your browser.</p>
        <select id="indicator-add">
          <option value="">＋ Add indicator…</option>
          ${options}
        </select>
        <ul id="indicator-active-list" class="provider-list" style="margin-top: 12px;"></ul>
        <button class="ghost" id="close-indicators">Close</button>
      </div>`;
    document.body.appendChild(el);
    return el;
  }

  private renderActive(): void {
    if (this.active.length === 0) {
      this.list.innerHTML = '<li>No indicators active.</li>';
      return;
    }
    this.list.innerHTML = this.active.map((a) => {
      const def = INDICATORS.find((d) => d.id === a.defId);
      const label = def?.label ?? a.defId;
      const paramFields = Object.keys(a.params).map((k) => `
        <label class="param">
          <span>${k}</span>
          <input type="number" data-uid="${a.uid}" data-param="${k}" value="${a.params[k]}" step="any" />
        </label>
      `).join('');
      return `<li style="flex-direction: column; align-items: stretch;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong>${label}</strong>
          <button class="ghost" data-remove="${a.uid}">Remove</button>
        </div>
        ${paramFields ? `<div class="param-row">${paramFields}</div>` : ''}
      </li>`;
    }).join('');
    this.list.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = btn.dataset.remove!;
        this.active = this.active.filter((a) => a.uid !== uid);
        this.persistAndRender();
      });
    });
    this.list.querySelectorAll<HTMLInputElement>('input[data-uid]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const uid = inp.dataset.uid!;
        const key = inp.dataset.param!;
        const v = Number(inp.value);
        const a = this.active.find((x) => x.uid === uid);
        if (a) {
          a.params = { ...a.params, [key]: Number.isFinite(v) ? v : 0 };
          this.persistAndRender();
        }
      });
    });
  }
}
