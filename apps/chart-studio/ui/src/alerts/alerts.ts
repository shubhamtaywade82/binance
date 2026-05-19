import type { ProviderClient, BookTicker } from '../provider-client';

const STORAGE_KEY = 'chart-studio:alerts:v1';

export type AlertOp = '>' | '<' | 'cross_above' | 'cross_below';

export interface PriceAlert {
  id: string;
  provider: string;
  symbol: string;
  op: AlertOp;
  price: number;
  /** Once triggered, do we keep firing or expire? */
  oneShot: boolean;
  /** Note text shown in toast / notification. */
  note?: string;
  /** ISO timestamp set when triggered (oneShot or for history). */
  triggeredAt?: number;
  /** Whether this alert is currently armed. */
  active: boolean;
  /** Last observed price, used for crossover detection. */
  lastPrice?: number;
}

const loadStored = (): PriceAlert[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const persist = (list: PriceAlert[]): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch { /* noop */ }
};

const newId = (): string => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Client-side alert engine. Subscribes to bookTicker for every active alert's
 * symbol (ref-counted across alerts on the same symbol). Evaluates conditions
 * on each tick. Surfaces hits via toast + Browser Notification API.
 */
export class AlertEngine {
  private alerts: PriceAlert[] = loadStored();
  private subs = new Map<string, { unsub: () => void; refs: Set<string> }>();
  private listeners = new Set<(alert: PriceAlert) => void>();

  constructor(private readonly client: ProviderClient) {
    for (const a of this.alerts) if (a.active) this.ensureSub(a);
    if ('Notification' in window && Notification.permission === 'default') {
      // Request lazily on first add() instead of on load.
    }
  }

  onTrigger(fn: (a: PriceAlert) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  list(): PriceAlert[] { return [...this.alerts].sort((a, b) => Number(b.active) - Number(a.active)); }

  add(input: Omit<PriceAlert, 'id' | 'active' | 'lastPrice'>): PriceAlert {
    const a: PriceAlert = { ...input, id: newId(), active: true };
    this.alerts.push(a);
    persist(this.alerts);
    this.ensureSub(a);
    void this.requestPermissionOnce();
    return a;
  }

  remove(id: string): void {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return;
    this.releaseSub(a);
    this.alerts = this.alerts.filter((x) => x.id !== id);
    persist(this.alerts);
  }

  toggle(id: string): void {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) return;
    a.active = !a.active;
    if (a.active) this.ensureSub(a); else this.releaseSub(a);
    persist(this.alerts);
  }

  private keyOf(a: { provider: string; symbol: string }): string { return `${a.provider}:${a.symbol}`; }

  private ensureSub(a: PriceAlert): void {
    const key = this.keyOf(a);
    let entry = this.subs.get(key);
    if (entry) { entry.refs.add(a.id); return; }
    const unsub = this.client.streamBookTicker(a.provider, a.symbol, (t) => this.onTick(a.provider, a.symbol, t));
    entry = { unsub, refs: new Set([a.id]) };
    this.subs.set(key, entry);
  }

  private releaseSub(a: PriceAlert): void {
    const key = this.keyOf(a);
    const entry = this.subs.get(key);
    if (!entry) return;
    entry.refs.delete(a.id);
    if (entry.refs.size === 0) {
      entry.unsub();
      this.subs.delete(key);
    }
  }

  private onTick(provider: string, symbol: string, t: BookTicker): void {
    const mid = (t.bestBidPrice + t.bestAskPrice) / 2;
    if (!Number.isFinite(mid)) return;
    let dirty = false;
    for (const a of this.alerts) {
      if (!a.active || a.provider !== provider || a.symbol !== symbol) continue;
      const fired = this.evaluate(a, mid);
      a.lastPrice = mid;
      if (fired) {
        a.triggeredAt = Date.now();
        if (a.oneShot) {
          a.active = false;
          this.releaseSub(a);
        }
        this.notify(a);
        dirty = true;
      }
    }
    if (dirty) persist(this.alerts);
  }

  private evaluate(a: PriceAlert, mid: number): boolean {
    switch (a.op) {
      case '>': return mid > a.price;
      case '<': return mid < a.price;
      case 'cross_above': return typeof a.lastPrice === 'number' && a.lastPrice <= a.price && mid > a.price;
      case 'cross_below': return typeof a.lastPrice === 'number' && a.lastPrice >= a.price && mid < a.price;
    }
  }

  private notify(a: PriceAlert): void {
    for (const fn of this.listeners) fn(a);
    if ('Notification' in window && Notification.permission === 'granted') {
      const title = `${a.provider} · ${a.symbol} ${a.op} ${a.price}`;
      const body = a.note ?? `Current ~${a.lastPrice?.toFixed(4)}`;
      try { new Notification(title, { body, tag: a.id }); } catch { /* noop */ }
    }
  }

  private async requestPermissionOnce(): Promise<void> {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'default') return;
    try { await Notification.requestPermission(); } catch { /* noop */ }
  }
}
