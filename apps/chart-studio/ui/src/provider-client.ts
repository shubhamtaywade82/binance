/**
 * Thin client for the chart-studio gateway. One WebSocket, multiplexed
 * by stream id; REST helpers for federated search.
 *
 * Wire format mirrors packages/gateway/src/ws-router.ts.
 */

export interface Candle {
  openTime: number; open: number; high: number; low: number; close: number; volume: number; closeTime?: number; sealed?: boolean;
}

export interface DepthDelta {
  firstUpdateId: number; finalUpdateId: number; prevUpdateId?: number;
  bids: [number, number][]; asks: [number, number][]; ts: number; replacement?: boolean;
}

export interface OrderBookSnapshot {
  lastUpdateId: number; bids: [number, number][]; asks: [number, number][]; ts: number;
}

export interface Trade { price: number; qty: number; ts: number; makerSide: boolean; tradeId?: number }
export interface BookTicker { bestBidPrice: number; bestBidQty: number; bestAskPrice: number; bestAskQty: number; ts: number }

export interface ProviderInfo { provider: string; displayName: string; online: boolean; lastSeen: number }
export interface SymbolRef { provider: string; symbol: string; label?: string; segment?: string }

export type Channel = 'candle' | 'depth' | 'trade' | 'ticker';

type FrameKind = 'snapshot' | 'update' | 'error';

interface Frame {
  id: string; type: FrameKind; provider: string; symbol: string; channel: Channel; key?: string;
  data?: unknown; error?: string;
}

interface Pending {
  onSnapshot: (data: unknown) => void;
  onUpdate: (data: unknown) => void;
  onError?: (err: string) => void;
}

const wsUrlFromLocation = (): string => {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
};

export class ProviderClient {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, Pending>();
  /** Queue of frames to send once the WS opens. */
  private outbox: string[] = [];
  private nextId = 1;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(connected: boolean) => void>();

  constructor(private readonly wsUrl: string = wsUrlFromLocation()) {
    this.connect();
  }

  onConnectionChange(fn: (connected: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private connect(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      for (const msg of this.outbox) ws.send(msg);
      this.outbox = [];
      // Re-subscribe to all active streams.
      for (const [id, ] of this.subs) {
        const meta = this.subMeta.get(id);
        if (meta) ws.send(JSON.stringify({ op: 'sub', id, ...meta }));
      }
      for (const fn of this.listeners) fn(true);
    });
    ws.addEventListener('message', (ev) => {
      let frame: Frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      const sub = this.subs.get(frame.id);
      if (!sub) return;
      if (frame.type === 'snapshot') sub.onSnapshot(frame.data);
      else if (frame.type === 'update') sub.onUpdate(frame.data);
      else if (frame.type === 'error' && sub.onError) sub.onError(frame.error ?? 'unknown error');
    });
    ws.addEventListener('close', () => {
      for (const fn of this.listeners) fn(false);
      this.ws = null;
      const attempt = ++this.reconnectAttempts;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
    ws.addEventListener('error', () => { /* close handler will reconnect */ });
  }

  private subMeta = new Map<string, { provider: string; symbol: string; channel: Channel; interval?: string }>();

  private send(obj: unknown): void {
    const msg = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else this.outbox.push(msg);
  }

  private subscribe<S, U>(
    meta: { provider: string; symbol: string; channel: Channel; interval?: string },
    onSnapshot: (data: S) => void,
    onUpdate: (data: U) => void,
  ): () => void {
    const id = String(this.nextId++);
    this.subs.set(id, {
      onSnapshot: (d) => onSnapshot(d as S),
      onUpdate: (d) => onUpdate(d as U),
    });
    this.subMeta.set(id, meta);
    this.send({ op: 'sub', id, ...meta });
    return () => {
      this.subs.delete(id);
      this.subMeta.delete(id);
      this.send({ op: 'unsub', id });
    };
  }

  streamCandles(provider: string, symbol: string, interval: string, onSnapshot: (c: Candle[]) => void, onUpdate: (c: { candle: Candle; isFinal: boolean }) => void): () => void {
    return this.subscribe({ provider, symbol, channel: 'candle', interval }, onSnapshot, onUpdate);
  }

  streamDepth(provider: string, symbol: string, onSnapshot: (s: OrderBookSnapshot) => void, onUpdate: (d: DepthDelta) => void): () => void {
    return this.subscribe({ provider, symbol, channel: 'depth' }, onSnapshot, onUpdate);
  }

  streamTrades(provider: string, symbol: string, onTrade: (t: Trade) => void): () => void {
    return this.subscribe<unknown, Trade>({ provider, symbol, channel: 'trade' }, () => undefined, onTrade);
  }

  streamBookTicker(provider: string, symbol: string, onTicker: (t: BookTicker) => void): () => void {
    return this.subscribe<unknown, BookTicker>({ provider, symbol, channel: 'ticker' }, () => undefined, onTicker);
  }

  async listProviders(): Promise<ProviderInfo[]> {
    const r = await fetch('/api/providers');
    if (!r.ok) return [];
    return r.json();
  }

  async searchSymbols(q: string, limit = 20): Promise<SymbolRef[]> {
    const r = await fetch(`/api/symbols/search?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    return r.json();
  }
}
