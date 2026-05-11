import WebSocket from 'ws';
import {
  buildCombinedStreamUrl,
  groupStreamsByRoute,
  type BinanceProductWs,
  type BinanceWsRoute,
} from '../../binance/ws-routing';

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
  product?: BinanceProductWs;
  /** Override constructor for tests. */
  wsFactory?: (url: string) => WebSocket;
}

type Listener = (t: BookTick) => void;

interface FeedConnection {
  route: BinanceWsRoute;
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
  streams: string[];
}

export class BookTickerFeed {
  private connections = new Map<BinanceWsRoute, FeedConnection>();
  private latestMap = new Map<string, BookTick>();
  private lastTradeMap = new Map<string, number>();
  private listeners: Listener[] = [];
  private closed = false;

  constructor(private readonly opts: BookTickerFeedOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    for (const conn of this.connections.values()) {
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      if (!conn.ws) continue;
      const sock = conn.ws;
      conn.ws = null;
      sock.removeAllListeners();
      sock.close();
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

  private streams(): string[] {
    const parts: string[] = [];
    for (const s of this.opts.symbols) {
      const lower = s.toLowerCase();
      parts.push(`${lower}@bookTicker`, `${lower}@aggTrade`);
    }
    return parts;
  }

  private connect(): void {
    if (this.closed) return;
    const grouped = groupStreamsByRoute(this.product(), this.streams());
    for (const [route, streams] of grouped) {
      this.connectRoute(this.ensureConnection(route, streams));
    }
  }

  private product(): BinanceProductWs {
    return this.opts.product ?? 'usdm';
  }

  private ensureConnection(route: BinanceWsRoute, streams: string[]): FeedConnection {
    let conn = this.connections.get(route);
    if (!conn) {
      conn = { route, ws: null, reconnectTimer: null, attempt: 0, streams };
      this.connections.set(route, conn);
    } else {
      conn.streams = streams;
    }
    return conn;
  }

  private connectRoute(conn: FeedConnection): void {
    if (this.closed || conn.ws || conn.streams.length === 0) return;
    const url = buildCombinedStreamUrl(this.opts.wsBase, this.product(), conn.route, conn.streams);
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    const socket = factory(url);
    conn.ws = socket;

    socket.on('open', () => {
      conn.attempt = 0;
    });

    socket.on('ping', (payload: Buffer) => {
      try {
        socket.pong(payload);
      } catch {
        // ws normally auto-pongs; ignore manual pong failures
      }
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
      if (conn.ws === socket) conn.ws = null;
      if (!this.closed) this.scheduleReconnect(conn);
    });

    socket.on('error', () => {
      // surfaced via reconnect on close
    });
  }

  private scheduleReconnect(conn: FeedConnection): void {
    if (this.closed || conn.reconnectTimer) return;
    conn.attempt += 1;
    const delayMs = Math.min(60_000, 500 * 2 ** Math.min(conn.attempt, 10));
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this.connectRoute(conn);
    }, delayMs);
  }
}
