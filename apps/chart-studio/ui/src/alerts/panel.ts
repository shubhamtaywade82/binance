import type { AlertEngine, AlertOp, PriceAlert } from './alerts';

export class AlertsPanel {
  private root: HTMLElement;
  private toastRoot: HTMLElement;

  constructor(
    private readonly engine: AlertEngine,
    private readonly getContext: () => { provider: string; symbol: string } | null,
  ) {
    this.root = document.getElementById('alerts-panel')!;
    this.toastRoot = this.ensureToastRoot();
    this.render();
    this.engine.onTrigger((a) => this.showToast(a));
    setInterval(() => this.render(), 4000);

    document.getElementById('alerts-add-btn')?.addEventListener('click', () => this.promptCreate());
  }

  private ensureToastRoot(): HTMLElement {
    let el = document.getElementById('toast-root');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'toast-root';
    el.className = 'toast-root';
    document.body.appendChild(el);
    return el;
  }

  private render(): void {
    const list = this.engine.list();
    if (list.length === 0) {
      this.root.innerHTML = '<div class="alerts-empty">No alerts. Click + to create one for the active symbol.</div>';
      return;
    }
    this.root.innerHTML = list.map((a) => this.rowHtml(a)).join('');
    this.root.querySelectorAll<HTMLElement>('[data-toggle]').forEach((b) => {
      b.addEventListener('click', () => this.engine.toggle(b.dataset.toggle!));
    });
    this.root.querySelectorAll<HTMLElement>('[data-remove]').forEach((b) => {
      b.addEventListener('click', () => { this.engine.remove(b.dataset.remove!); this.render(); });
    });
  }

  private rowHtml(a: PriceAlert): string {
    const stateClass = a.active ? 'armed' : 'idle';
    const triggered = a.triggeredAt ? `<span class="alert-fired">fired ${timeAgo(a.triggeredAt)}</span>` : '';
    const opLabel = a.op === 'cross_above' ? '↗' : a.op === 'cross_below' ? '↘' : a.op;
    return `<div class="alert-row ${stateClass}">
      <div class="alert-main">
        <div class="alert-sym">${a.symbol}</div>
        <div class="alert-cond">${opLabel} ${a.price} ${a.oneShot ? '(once)' : '(persistent)'}</div>
        ${triggered}
      </div>
      <div class="alert-actions">
        <button class="ghost" data-toggle="${a.id}">${a.active ? 'Pause' : 'Arm'}</button>
        <button class="ghost" data-remove="${a.id}">✕</button>
      </div>
    </div>`;
  }

  private promptCreate(): void {
    const ctx = this.getContext();
    if (!ctx) {
      alert('Open a chart first, then create an alert.');
      return;
    }
    const condition = prompt(`Create alert for ${ctx.symbol}.\nFormat: "<op> <price>"\nops: > | < | cross_above | cross_below\nexample: "> 70000"`, '> 0');
    if (!condition) return;
    const match = condition.trim().match(/^(>|<|cross_above|cross_below)\s+([0-9]+(?:\.[0-9]+)?)$/);
    if (!match) {
      alert('Could not parse. Use e.g. "> 70000" or "cross_above 0.5".');
      return;
    }
    const op = match[1] as AlertOp;
    const price = Number(match[2]);
    const oneShot = confirm('OK = one-shot (fires once and disarms)\nCancel = persistent (keeps firing while condition holds)');
    this.engine.add({ provider: ctx.provider, symbol: ctx.symbol, op, price, oneShot });
    this.render();
  }

  private showToast(a: PriceAlert): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = `<strong>${a.symbol}</strong> ${a.op} ${a.price}<br/><span class="toast-meta">${a.provider}${a.note ? ' · ' + a.note : ''}</span>`;
    this.toastRoot.appendChild(t);
    setTimeout(() => { t.classList.add('fade'); }, 6000);
    setTimeout(() => { t.remove(); }, 7000);
  }
}

const timeAgo = (ts: number): string => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
