import WebSocket from 'ws';
import type { BinanceRestClient } from './rest-client';
import { createListenKey, keepAliveListenKey, deleteListenKey } from './rest-trade';

// ─── Event payloads ────────────────────────────────────────────────────────

export interface OrderTradeUpdate {
  /** Event type: "ORDER_TRADE_UPDATE" */
  e: string;
  /** Event time */
  E: number;
  /** Transaction time */
  T: number;
  order: {
    /** Symbol */
    s: string;
    /** Client order ID */
    c: string;
    /** Order side: BUY / SELL */
    S: string;
    /** Order type */
    o: string;
    /** Time in force */
    f: string;
    /** Original quantity */
    q: string;
    /** Original price */
    p: string;
    /** Average price */
    ap: string;
    /** Stop price */
    sp: string;
    /** Execution type */
    x: string;
    /** Order status */
    X: string;
    /** Order ID */
    i: number;
    /** Order last filled quantity */
    l: string;
    /** Order filled accumulated quantity */
    z: string;
    /** Last filled price */
    L: string;
    /** Commission amount */
    n: string;
    /** Commission asset */
    N: string | null;
    /** Trade ID */
    t: number;
    /** Realized profit */
    rp: string;
    /** Is reduce only */
    R: boolean;
    /** Working type */
    wt: string;
    /** Original order type */
    ot: string;
    /** Position side */
    ps: string;
    /** If close-all */
    cp: boolean;
    /** Activation price */
    AP?: string;
    /** Callback rate */
    cr?: string;
    /** Algo strategy ID (present when order was placed via /fapi/v1/algoOrder). */
    si?: number;
    /** Algo strategy status (e.g. TRIGGERED). */
    ss?: string;
  };
}

export interface AccountUpdate {
  e: string;
  E: number;
  T: number;
  a: {
    m: string;
    B: Array<{ a: string; wb: string; cw: string; bc: string }>;
    P: Array<{
      s: string;
      pa: string;
      ep: string;
      cr: string;
      up: string;
      mt: string;
      iw: string;
      ps: string;
    }>;
  };
}

export interface MarginCallEvent {
  e: string;
  E: number;
  cw: string;
  p: Array<{ s: string; ps: string; pa: string; mt: string; iw: string; mp: string; up: string; mm: string }>;
}

export interface AccountConfigUpdate {
  e: 'ACCOUNT_CONFIG_UPDATE';
  E: number;
  T: number;
  /** Leverage change. Present when user changes leverage. */
  ac?: { s: string; l: number };
  /** Multi-assets margin change. Present when user toggles multi-assets mode. */
  ai?: { j: boolean };
}

export interface TradeLiteEvent {
  e: 'TRADE_LITE';
  E: number;
  T: number;
  s: string;
  q: string;
  p: string;
  m: boolean;
  L: string;
}

export interface PrivateWsCallbacks {
  onOrderUpdate?: (event: OrderTradeUpdate) => void;
  onAccountUpdate?: (event: AccountUpdate) => void;
  onMarginCall?: (event: MarginCallEvent) => void;
  /** User stream `ALGO_UPDATE` / `ALGO_ORDER_UPDATE` payloads (shape varies by Binance version). */
  onAlgoOrderUpdate?: (event: Record<string, unknown>) => void;
  /** TP/SL conditional trigger rejected by the engine. */
  onConditionalOrderTriggerReject?: (event: Record<string, unknown>) => void;
  /** Leverage or margin mode changed externally (e.g. via Binance app). */
  onAccountConfigUpdate?: (event: AccountConfigUpdate) => void;
  /** Lightweight fill notification (lower bandwidth than ORDER_TRADE_UPDATE). */
  onTradeLite?: (event: TradeLiteEvent) => void;
  onListenKeyExpired?: () => void;
  onError?: (err: Error) => void;
  onReconnect?: (attempt: number) => void;
  onOpen?: () => void;
  onClose?: () => void;
}

export interface PrivateWsOptions {
  /** Root WebSocket URL e.g. `wss://fstream.binance.com` */
  wsBase: string;
  client: BinanceRestClient;
  callbacks?: PrivateWsCallbacks;
  /** How often to renew the listen key (ms). Default 30 min. */
  renewIntervalMs?: number;
  /** Factory override for tests. */
  wsFactory?: (url: string) => WebSocket;
}

/**
 * Binance FAPI private user-data stream.
 *
 * Connects to `wss://fstream.binance.com/private/ws?listenKey=<key>`.
 * Handles ORDER_TRADE_UPDATE, ACCOUNT_UPDATE, MARGIN_CALL.
 * Auto-renews the listen key every 30 min and reconnects on drops.
 */
export class BinancePrivateWs {
  private listenKey: string | null = null;
  private ws: WebSocket | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private readonly renewIntervalMs: number;
  private cb: PrivateWsCallbacks;

  constructor(private readonly opts: PrivateWsOptions) {
    this.renewIntervalMs = opts.renewIntervalMs ?? 30 * 60 * 1000;
    this.cb = opts.callbacks ?? {};
  }

  setCallbacks(cb: PrivateWsCallbacks): void {
    this.cb = cb;
  }

  async start(): Promise<void> {
    this.closed = false;
    this.listenKey = await createListenKey(this.opts.client);
    this.connect();
    this.scheduleRenew();
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.clearRenewTimer();
    this.clearReconnectTimer();
    this.closeSocket(1000, 'shutdown');
    if (this.listenKey) {
      try {
        await deleteListenKey(this.opts.client, this.listenKey);
      } catch {
        // best-effort
      }
      this.listenKey = null;
    }
    this.cb.onClose?.();
  }

  private wsUrl(): string {
    const root = this.opts.wsBase.replace(/\/$/, '');
    return `${root}/private/ws?listenKey=${this.listenKey}`;
  }

  private connect(): void {
    if (this.closed || !this.listenKey) return;
    const url = this.wsUrl();
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u));
    let socket: WebSocket;
    try {
      socket = factory(url);
    } catch (e) {
      this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.on('open', () => {
      this.attempt = 0;
      this.cb.onOpen?.();
    });

    socket.on('ping', (payload: Buffer) => {
      try {
        socket.pong(payload);
      } catch {
        // ignore
      }
    });

    socket.on('message', (raw: WebSocket.RawData) => {
      try {
        const text = typeof raw === 'string' ? raw : raw.toString();
        this.handleMessage(JSON.parse(text) as Record<string, unknown>);
      } catch (e) {
        this.cb.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    });

    socket.on('close', (code: number) => {
      if (this.ws === socket) this.ws = null;
      if (!this.closed) {
        if (code === 1000) return;
        this.scheduleReconnect();
      }
    });

    socket.on('error', (err: Error) => {
      this.cb.onError?.(err);
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const evt = msg.e as string | undefined;
    if (!evt) return;

    if (evt === 'ORDER_TRADE_UPDATE') {
      this.cb.onOrderUpdate?.(msg as unknown as OrderTradeUpdate);
      return;
    }
    if (evt === 'ACCOUNT_UPDATE') {
      this.cb.onAccountUpdate?.(msg as unknown as AccountUpdate);
      return;
    }
    if (evt === 'MARGIN_CALL') {
      this.cb.onMarginCall?.(msg as unknown as MarginCallEvent);
      return;
    }
    if (evt === 'ALGO_UPDATE' || evt === 'ALGO_ORDER_UPDATE') {
      this.cb.onAlgoOrderUpdate?.(msg);
      return;
    }
    if (evt === 'CONDITIONAL_ORDER_TRIGGER_REJECT') {
      this.cb.onConditionalOrderTriggerReject?.(msg);
      return;
    }
    if (evt === 'ACCOUNT_CONFIG_UPDATE') {
      this.cb.onAccountConfigUpdate?.(msg as unknown as AccountConfigUpdate);
      return;
    }
    if (evt === 'TRADE_LITE') {
      this.cb.onTradeLite?.(msg as unknown as TradeLiteEvent);
      return;
    }
    if (evt === 'listenKeyExpired') {
      this.cb.onListenKeyExpired?.();
      void this.handleListenKeyExpired();
    }
  }

  private async handleListenKeyExpired(): Promise<void> {
    if (this.closed) return;
    try {
      const old = this.listenKey;
      this.listenKey = null;
      if (old) {
        try {
          await deleteListenKey(this.opts.client, old);
        } catch {
          // Expired keys often reject delete — proceed with a fresh key.
        }
      }
      this.listenKey = await createListenKey(this.opts.client);
      this.closeSocket(1012, 'listen_key_expired');
      this.connect();
    } catch (e) {
      this.cb.onError?.(e instanceof Error ? e : new Error(`listenKey rotate failed: ${e}`));
      this.scheduleReconnect();
    }
  }

  private scheduleRenew(): void {
    this.clearRenewTimer();
    this.renewTimer = setInterval(() => void this.renewListenKey(), this.renewIntervalMs);
    if (typeof this.renewTimer.unref === 'function') this.renewTimer.unref();
  }

  private clearRenewTimer(): void {
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
  }

  private async renewListenKey(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.listenKey) {
        await keepAliveListenKey(this.opts.client, this.listenKey);
      } else {
        this.listenKey = await createListenKey(this.opts.client);
        this.closeSocket(1012, 'listenkey_refresh');
        this.connect();
      }
    } catch (e) {
      this.cb.onError?.(e instanceof Error ? e : new Error(`listenKey renew failed: ${e}`));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.attempt += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempt, 6));
    this.cb.onReconnect?.(this.attempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, delayMs);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(code: number, reason: string): void {
    if (!this.ws) return;
    const s = this.ws;
    this.ws = null;
    s.removeAllListeners();
    try {
      s.close(code, reason);
    } catch {
      // ignore
    }
  }
}
