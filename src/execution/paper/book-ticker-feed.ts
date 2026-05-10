import WebSocket from 'ws';

export interface BookTick {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  ts: number;
}

export interface BookTickerFeedOptions {
  wsBase: string;
  symbols: string[];
  /** Override constructor for tests. */
  wsFactory?: (url: string) => WebSocket;
}

type Listener = (t: BookTick) => void;

export class BookTickerFeed {
  private ws: WebSocket | null = null;
  private latestMap = new Map<string, BookTick>();
  private lastTradeMap = new Map<string, number>();
  private listeners: Listener[] = [];
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;

  constructor(private readonly opts: BookTickerFeedOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  latest(symbol: string): BookTick | undefined {
    return this.latestMap.get(symbol.toUpperCase());
  }

  lastTrade(symbol: string): number | undefined {
    return this.lastTradeMap.get(symbol.toUpperCase());
  }

  onUpdate(cb: Listener): void {
    this.listeners.push(cb);
  }

  /** Test helper. */
  ingest(t: BookTick): void {
    this.latestMap.set(t.symbol.toUpperCase(), t);
    for (const l of this.listeners) l(t);
  }

  /** Test helper. */
  ingestTrade(symbol: string, price: number): void {
    this.lastTradeMap.set(symbol.toUpperCase(), price);
  }

  private streams(): string {
    const parts: string[] = [];
    for (const s of this.opts.symbols) {
      const lower = s.toLowerCase();
      parts.push(`${lower}@bookTicker`, `${lower}@aggTrade`);
    }
    return parts.join('/');
  }

  private connect(): void {
    if (this.closed) return;
    const base = this.opts.wsBase.replace(/\/$/, '');
    const url = `${base}/stream?streams=${this.streams()}`;
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    const socket = factory(url);
    this.ws = socket;

    socket.on('open', () => {
      this.attempt = 0;
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const data = (msg.data ?? msg) as Record<string, unknown>;
        const evt = data.e as string | undefined;
        const symbolU = String(data.s ?? '').toUpperCase();
        if (!symbolU) {
          if (data.s === undefined && data.b !== undefined && data.a !== undefined && data.s !== undefined) {
            // bookTicker may omit "e"
          }
        }
        if (data.b !== undefined && data.a !== undefined) {
          const bid = Number(data.b);
          const ask = Number(data.a);
          const sym = String(data.s ?? '').toUpperCase();
          if (Number.isFinite(bid) && Number.isFinite(ask) && sym) {
            const tick: BookTick = {
              symbol: sym,
              bestBid: bid,
              bestAsk: ask,
              spread: ask - bid,
              ts: Number(data.T ?? data.E ?? Date.now()),
            };
            this.latestMap.set(sym, tick);
            for (const l of this.listeners) l(tick);
          }
          return;
        }
        if (evt === 'aggTrade') {
          const sym = String(data.s ?? '').toUpperCase();
          const price = Number(data.p);
          if (sym && Number.isFinite(price)) this.lastTradeMap.set(sym, price);
        }
      } catch {
        // ignore parse errors
      }
    });

    socket.on('close', () => {
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    });

    socket.on('error', () => {
      // surfaced via reconnect on close
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.attempt += 1;
    const delayMs = Math.min(60_000, 500 * 2 ** Math.min(this.attempt, 10));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}
