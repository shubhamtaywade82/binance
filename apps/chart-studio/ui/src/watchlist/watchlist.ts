import type { ProviderClient, SymbolRef } from '../provider-client';

const STORAGE_KEY = 'chart-studio:watchlist:v1';

export interface WatchlistEntry {
  provider: string;
  symbol: string;
  label?: string;
  segment?: string;
  /** Last seen LTP, populated from streamBookTicker subscriptions. */
  ltp?: number;
  prevLtp?: number;
}

interface SubBundle { unsub: () => void }

const loadStored = (): WatchlistEntry[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const persist = (list: WatchlistEntry[]): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map(({ ltp: _l, prevLtp: _p, ...rest }) => rest))); } catch { /* ignore */ }
};

/**
 * Sidebar watchlist. Persists to localStorage, subscribes to bookTicker
 * for live prices, and emits a "select" callback on click.
 */
export class WatchlistPanel {
  private entries: WatchlistEntry[] = loadStored();
  private subs = new Map<string, SubBundle>();
  private listeners = new Set<(ref: SymbolRef) => void>();

  constructor(
    private readonly root: HTMLElement,
    private readonly client: ProviderClient,
  ) {
    this.subscribeAll();
    this.render();

    const addBtn = document.getElementById('watchlist-add');
    addBtn?.addEventListener('click', () => {
      const ev = new CustomEvent('watchlist:open-search');
      document.dispatchEvent(ev);
    });
  }

  onSelect(fn: (ref: SymbolRef) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  list(): WatchlistEntry[] { return this.entries; }

  add(ref: SymbolRef): void {
    const key = this.keyOf(ref.provider, ref.symbol);
    if (this.entries.some((e) => this.keyOf(e.provider, e.symbol) === key)) return;
    this.entries.push({ provider: ref.provider, symbol: ref.symbol, label: ref.label, segment: ref.segment });
    persist(this.entries);
    this.subscribeOne(this.entries[this.entries.length - 1]!);
    this.render();
  }

  remove(provider: string, symbol: string): void {
    const key = this.keyOf(provider, symbol);
    const sub = this.subs.get(key);
    if (sub) sub.unsub();
    this.subs.delete(key);
    this.entries = this.entries.filter((e) => this.keyOf(e.provider, e.symbol) !== key);
    persist(this.entries);
    this.render();
  }

  setActive(provider: string, symbol: string): void {
    this.root.querySelectorAll<HTMLElement>('.watch-row').forEach((el) => {
      const active = el.dataset.key === this.keyOf(provider, symbol);
      el.classList.toggle('active', active);
    });
  }

  private keyOf(p: string, s: string): string { return `${p}:${s}`; }

  private subscribeAll(): void {
    for (const e of this.entries) this.subscribeOne(e);
  }

  private subscribeOne(e: WatchlistEntry): void {
    const key = this.keyOf(e.provider, e.symbol);
    if (this.subs.has(key)) return;
    const unsub = this.client.streamBookTicker(e.provider, e.symbol, (t) => {
      const mid = (t.bestBidPrice + t.bestAskPrice) / 2;
      if (Number.isFinite(mid)) {
        e.prevLtp = e.ltp;
        e.ltp = mid;
        this.renderRow(e);
      }
    });
    this.subs.set(key, { unsub });
  }

  private render(): void {
    if (this.entries.length === 0) {
      this.root.innerHTML = '<div class="watch-empty">Press ⌘K to search and add symbols.</div>';
      return;
    }
    this.root.innerHTML = this.entries.map((e) => this.rowHtml(e)).join('');
    this.root.querySelectorAll<HTMLElement>('.watch-row').forEach((el) => {
      el.addEventListener('click', (ev) => {
        if ((ev.target as HTMLElement).classList.contains('watch-remove')) return;
        const provider = el.dataset.provider!;
        const symbol = el.dataset.symbol!;
        for (const fn of this.listeners) fn({ provider, symbol });
      });
      el.querySelector<HTMLElement>('.watch-remove')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.remove(el.dataset.provider!, el.dataset.symbol!);
      });
    });
  }

  private renderRow(e: WatchlistEntry): void {
    const key = this.keyOf(e.provider, e.symbol);
    const row = this.root.querySelector<HTMLElement>(`.watch-row[data-key="${CSS.escape(key)}"]`);
    if (!row) return;
    const ltpEl = row.querySelector<HTMLElement>('.watch-ltp');
    if (!ltpEl) return;
    const ltp = e.ltp;
    if (typeof ltp === 'number' && Number.isFinite(ltp)) {
      ltpEl.textContent = formatPrice(ltp);
      if (typeof e.prevLtp === 'number') {
        ltpEl.classList.remove('up', 'down');
        if (ltp > e.prevLtp) ltpEl.classList.add('up');
        else if (ltp < e.prevLtp) ltpEl.classList.add('down');
      }
    }
  }

  private rowHtml(e: WatchlistEntry): string {
    const key = this.keyOf(e.provider, e.symbol);
    const provLabel = e.provider.replace(/^binance-/, '').replace(/-usdm$/, 'F');
    return `<div class="watch-row" data-key="${key}" data-provider="${e.provider}" data-symbol="${e.symbol}">
      <div class="watch-main">
        <div class="watch-sym">${e.symbol}</div>
        <div class="watch-meta">${provLabel}${e.segment ? ' · ' + e.segment : ''}</div>
      </div>
      <div class="watch-right">
        <span class="watch-ltp">${typeof e.ltp === 'number' ? formatPrice(e.ltp) : '—'}</span>
        <span class="watch-remove" title="Remove">✕</span>
      </div>
    </div>`;
  }
}

const formatPrice = (n: number): string => {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
};
