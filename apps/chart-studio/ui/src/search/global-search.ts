import type { ProviderClient, SymbolRef } from '../provider-client';

const debounce = <A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) => {
  let h: ReturnType<typeof setTimeout> | null = null;
  return (...args) => {
    if (h) clearTimeout(h);
    h = setTimeout(() => fn(...args), ms);
  };
};

export class GlobalSearch {
  private overlay: HTMLElement;
  private input: HTMLInputElement;
  private results: HTMLElement;
  private items: SymbolRef[] = [];
  private active = 0;

  constructor(
    private readonly client: ProviderClient,
    private readonly onSelect: (ref: SymbolRef) => void,
    private readonly onAddToWatchlist?: (ref: SymbolRef) => void,
  ) {
    this.overlay = document.getElementById('search-overlay')!;
    this.input = document.getElementById('search-input') as HTMLInputElement;
    this.results = document.getElementById('search-results')!;

    const trigger = document.getElementById('search-btn')!;
    trigger.addEventListener('click', () => this.open());

    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.open();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });
    document.addEventListener('watchlist:open-search', () => this.open());

    this.input.addEventListener('input', debounce(() => this.runSearch(this.input.value), 150));
    this.input.addEventListener('keydown', (e) => this.handleKey(e));
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  open(): void {
    this.overlay.classList.remove('hidden');
    this.input.value = '';
    this.input.focus();
    this.runSearch('');
  }

  close(): void {
    this.overlay.classList.add('hidden');
  }

  private async runSearch(q: string): Promise<void> {
    const items = await this.client.searchSymbols(q, 30);
    this.items = items;
    this.active = 0;
    this.render();
  }

  private render(): void {
    if (this.items.length === 0) {
      this.results.innerHTML = `<div class="item"><span class="meta">No results</span></div>`;
      return;
    }
    this.results.innerHTML = this.items.map((r, i) => `
      <div class="item ${i === this.active ? 'active' : ''}" data-idx="${i}">
        <div>
          <div class="sym">${r.symbol}</div>
          <div class="meta">${r.label ?? ''} · ${r.segment ?? ''}</div>
        </div>
        <div class="meta">${r.provider}</div>
      </div>
    `).join('');
    this.results.querySelectorAll<HTMLElement>('.item[data-idx]').forEach((el) => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.idx);
        this.select(idx);
      });
    });
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') { e.preventDefault(); this.active = Math.min(this.items.length - 1, this.active + 1); this.render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.active = Math.max(0, this.active - 1); this.render(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) this.addToWatchlist(this.active);
      else this.select(this.active);
    }
  }

  private select(idx: number): void {
    const ref = this.items[idx];
    if (!ref) return;
    this.onSelect(ref);
    if (this.onAddToWatchlist) this.onAddToWatchlist(ref);
    this.close();
  }

  private addToWatchlist(idx: number): void {
    const ref = this.items[idx];
    if (!ref || !this.onAddToWatchlist) return;
    this.onAddToWatchlist(ref);
  }
}
