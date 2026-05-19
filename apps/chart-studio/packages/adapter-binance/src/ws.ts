import WebSocket from 'ws';
import type { Candle } from '@chart-studio/adapter-core';
import type { BinanceConfig } from './rest';
import { wsBaseFor } from './rest';

type StreamMessage =
  | { stream: string; data: unknown }
  | Record<string, unknown>;

type Handler = (raw: unknown) => void;

/**
 * Pool that maintains one combined-stream WS per (product) and lets callers
 * register handlers for `<symbol>@<topic>` streams. Reconnects automatically.
 */
export class BinanceStreamPool {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<Handler>>(); // streamName -> handlers
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closed = false;

  constructor(private readonly cfg: BinanceConfig) {}

  subscribe(stream: string, fn: Handler): () => void {
    let set = this.handlers.get(stream);
    if (!set) {
      set = new Set();
      this.handlers.set(stream, set);
      this.reconnect();
    }
    set.add(fn);
    return () => {
      const s = this.handlers.get(stream);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) {
        this.handlers.delete(stream);
        this.reconnect();
      }
    };
  }

  shutdown(): void {
    this.closed = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => this.connect(), 50);
  }

  private connect(): void {
    if (this.closed) return;
    const streams = [...this.handlers.keys()];
    if (this.ws) {
      try { this.ws.close(); } catch { /* noop */ }
      this.ws = null;
    }
    if (streams.length === 0) return;

    const url = `${wsBaseFor(this.cfg)}/stream?streams=${streams.join('/')}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
    });
    ws.on('message', (raw) => {
      let parsed: StreamMessage;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      const stream = (parsed as { stream?: string }).stream;
      if (!stream) return;
      const set = this.handlers.get(stream);
      if (!set) return;
      const data = (parsed as { data?: unknown }).data;
      for (const fn of set) fn(data);
    });
    ws.on('error', () => { /* swallow; close will reconnect */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.handlers.size === 0) return;
    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
    this.connectTimer = setTimeout(() => this.connect(), delay);
  }
}

export const parseKlineEvent = (raw: unknown): { candle: Candle; isFinal: boolean } | null => {
  const k = (raw as { k?: Record<string, unknown> })?.k;
  if (!k) return null;
  const openTime = Number(k.t);
  const closeTime = Number(k.T);
  const open = Number(k.o);
  const high = Number(k.h);
  const low = Number(k.l);
  const close = Number(k.c);
  const volume = Number(k.v);
  const isFinal = Boolean(k.x);
  if (![openTime, open, high, low, close, volume].every(Number.isFinite)) return null;
  return { candle: { openTime, open, high, low, close, volume, closeTime, sealed: isFinal }, isFinal };
};
