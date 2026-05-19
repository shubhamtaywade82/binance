import WebSocket from 'ws';
import type { TokenProvider } from './token-provider';

/**
 * Dhan v2 Live Market Feed binary protocol.
 *
 * Subscribe in JSON, receive binary frames little-endian:
 *   Header (8 bytes): code(1) | length(2) | exchSeg(1) | securityId(4)
 *   Ticker (code 2):     LTP(f32), LTT(i32)
 *   Quote  (code 4):     LTP, LTQ(i16), LTT, ATP, Volume(i32), TSQ, TBQ, Open, Close, High, Low
 *   OI     (code 5):     OI(i32)
 *   PrevClose (code 6):  Close(f32), PrevOi(i32)
 *   Full   (code 8):     LTP, LTQ(i16), LTT, ATP, Vol, TSQ, TBQ, OI, HighOi, LowOi, Open, Close, High, Low, then 5×(bidQty,askQty,bidOrders,askOrders,bidPx,askPx)
 *   Disconnect (code 50): reason(i16)
 *
 * Subscription:
 *   { RequestCode: 15, InstrumentCount: N, InstrumentList: [{ ExchangeSegment, SecurityId }] }
 * RequestCode determines depth mode; 15=Quote, 17=Full, 21=Ticker per Dhan v2.
 * We use 17 by default so we get full top-5 depth + LTP in one stream.
 */

const FEED_BASE = 'wss://api-feed.dhan.co';
const REQ_TICKER = 15;
const REQ_QUOTE = 17;
const REQ_FULL = 21;
const REQ_DISCONNECT = 12;

export interface DhanTick {
  exchangeSegment: number;
  securityId: number;
  /** ms */
  ts: number;
  code: number;
  ltp?: number;
  ltq?: number;
  ltt?: number;
  atp?: number;
  volume?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  open?: number;
  close?: number;
  high?: number;
  low?: number;
  openInterest?: number;
  /** 5-level top-of-book; price, qty per side. */
  bids?: Array<[number, number]>;
  asks?: Array<[number, number]>;
}

export interface DhanSubscription {
  exchangeSegment: string;
  securityId: string;
}

type Handler = (tick: DhanTick) => void;

interface InternalSub {
  ins: DhanSubscription;
  /** Maps Dhan's numeric segment back to the string segment used by handlers. */
  fns: Set<Handler>;
}

const parseTick = (buf: Buffer): DhanTick | null => {
  if (buf.length < 8) return null;
  const code = buf.readUInt8(0);
  const exchSeg = buf.readUInt8(3);
  const securityId = buf.readInt32LE(4);
  const t: DhanTick = { exchangeSegment: exchSeg, securityId, ts: Date.now(), code };
  if (code === 2 && buf.length >= 16) {
    t.ltp = buf.readFloatLE(8);
    t.ltt = buf.readInt32LE(12);
    return t;
  }
  if (code === 4 && buf.length >= 50) {
    t.ltp = buf.readFloatLE(8);
    t.ltq = buf.readInt16LE(12);
    t.ltt = buf.readInt32LE(14);
    t.atp = buf.readFloatLE(18);
    t.volume = buf.readInt32LE(22);
    t.totalSellQty = buf.readInt32LE(26);
    t.totalBuyQty = buf.readInt32LE(30);
    t.open = buf.readFloatLE(34);
    t.close = buf.readFloatLE(38);
    t.high = buf.readFloatLE(42);
    t.low = buf.readFloatLE(46);
    return t;
  }
  if (code === 5 && buf.length >= 12) {
    t.openInterest = buf.readInt32LE(8);
    return t;
  }
  if (code === 6 && buf.length >= 16) {
    t.close = buf.readFloatLE(8);
    t.openInterest = buf.readInt32LE(12);
    return t;
  }
  if (code === 8 && buf.length >= 162) {
    t.ltp = buf.readFloatLE(8);
    t.ltq = buf.readInt16LE(12);
    t.ltt = buf.readInt32LE(14);
    t.atp = buf.readFloatLE(18);
    t.volume = buf.readInt32LE(22);
    t.totalSellQty = buf.readInt32LE(26);
    t.totalBuyQty = buf.readInt32LE(30);
    t.openInterest = buf.readInt32LE(34);
    // 38: HighOi (i32), 42: LowOi (i32)
    t.open = buf.readFloatLE(46);
    t.close = buf.readFloatLE(50);
    t.high = buf.readFloatLE(54);
    t.low = buf.readFloatLE(58);
    const bids: Array<[number, number]> = [];
    const asks: Array<[number, number]> = [];
    let off = 62;
    for (let i = 0; i < 5; i += 1) {
      const bidQty = buf.readInt32LE(off);
      const askQty = buf.readInt32LE(off + 4);
      // skip orders (i16 + i16) at off+8 / off+10
      const bidPx = buf.readFloatLE(off + 12);
      const askPx = buf.readFloatLE(off + 16);
      bids.push([bidPx, bidQty]);
      asks.push([askPx, askQty]);
      off += 20;
    }
    t.bids = bids;
    t.asks = asks;
    return t;
  }
  return null;
};

export class DhanStreamPool {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, InternalSub>(); // key = `${seg}:${secId}`
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private mode: number;

  constructor(private readonly tokens: TokenProvider, mode: 'ticker' | 'quote' | 'full' = 'full') {
    this.mode = mode === 'ticker' ? REQ_TICKER : mode === 'quote' ? REQ_QUOTE : REQ_FULL;
  }

  subscribe(ins: DhanSubscription, fn: Handler): () => void {
    const key = `${ins.exchangeSegment}:${ins.securityId}`;
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { ins, fns: new Set() };
      this.subs.set(key, entry);
      this.sendSub([ins]);
    }
    entry.fns.add(fn);
    this.ensureConnected();
    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.fns.delete(fn);
      if (e.fns.size === 0) {
        this.subs.delete(key);
        // Dhan v2 has no per-instrument unsubscribe; we just stop relaying.
      }
    };
  }

  shutdown(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.send(JSON.stringify({ RequestCode: REQ_DISCONNECT })); } catch { /* noop */ }
      try { this.ws.close(); } catch { /* noop */ }
    }
  }

  private ensureConnected(): void {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    void this.connect();
  }

  private scheduleReconnectAfterError(): void {
    if (this.closed) return;
    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let creds;
    try {
      creds = await this.tokens.get();
    } catch (err) {
      console.error('[adapter-dhanhq] token resolve failed', err);
      this.scheduleReconnectAfterError();
      return;
    }
    if (this.closed) return;
    const url = `${FEED_BASE}?version=2&token=${encodeURIComponent(creds.accessToken)}&clientId=${encodeURIComponent(creds.clientId)}&authType=2`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      const list: DhanSubscription[] = [...this.subs.values()].map((s) => s.ins);
      if (list.length > 0) this.sendSub(list);
    });

    ws.on('message', (raw) => {
      if (!(raw instanceof Buffer)) return;
      const tick = parseTick(raw);
      if (!tick) return;
      const key = `${tick.exchangeSegment}:${tick.securityId}`;
      // The numeric segment in the frame won't match our string keys directly,
      // so we look up by securityId across our subs.
      for (const [k, entry] of this.subs) {
        const [, secId] = k.split(':');
        if (secId && Number(secId) === tick.securityId) {
          for (const fn of entry.fns) fn(tick);
        }
      }
      void key;
    });

    ws.on('error', () => { /* let close handler schedule reconnect */ });

    ws.on('close', (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      // 401-equivalent close codes — refresh token before next reconnect.
      if (code === 1008 || code === 4001 || code === 4003) this.tokens.invalidate();
      this.scheduleReconnectAfterError();
    });
  }

  private sendSub(instruments: DhanSubscription[]): void {
    const send = (): void => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Chunk to 100 per message per Dhan limits
      for (let i = 0; i < instruments.length; i += 100) {
        const chunk = instruments.slice(i, i + 100);
        const body = {
          RequestCode: this.mode,
          InstrumentCount: chunk.length,
          InstrumentList: chunk.map((ins) => ({
            ExchangeSegment: ins.exchangeSegment,
            SecurityId: ins.securityId,
          })),
        };
        try { ws.send(JSON.stringify(body)); } catch { /* noop */ }
      }
    };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) send();
    else this.ensureConnected();
  }
}
