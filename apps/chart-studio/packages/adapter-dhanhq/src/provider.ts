import type { AxiosInstance } from 'axios';
import type {
  BookTicker,
  Candle,
  DepthDelta,
  InstrumentMeta,
  MarketDataProvider,
  OrderBookSnapshot,
  SymbolRef,
  Trade,
  Unsub,
} from '@chart-studio/adapter-core';
import {
  findInstrument,
  loadInstruments,
  searchInstruments,
  toInstrumentMeta,
  toSymbolRef,
  type DhanInstrument,
} from './instruments';
import { createClient, fetchCandles, fetchMarketDepth, type DhanCreds } from './rest';
import { DhanStreamPool, type DhanTick } from './ws';

export interface DhanProviderConfig {
  id?: string;
  displayName?: string;
  creds: DhanCreds;
  /** Override the scrip master URL (e.g. for testing). */
  scripMasterUrl?: string;
  /** "ticker" | "quote" | "full" — default "full" for depth + LTP. */
  feedMode?: 'ticker' | 'quote' | 'full';
}

export class DhanProvider implements MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  private client: AxiosInstance;
  private pool: DhanStreamPool;
  private instrumentCache: DhanInstrument[] = [];

  constructor(private readonly cfg: DhanProviderConfig) {
    this.id = cfg.id ?? 'dhanhq';
    this.displayName = cfg.displayName ?? 'DhanHQ';
    this.client = createClient(cfg.creds);
    this.pool = new DhanStreamPool(cfg.creds, cfg.feedMode ?? 'full');
  }

  async init(): Promise<void> {
    this.instrumentCache = await loadInstruments(this.cfg.scripMasterUrl).catch(() => []);
  }

  async shutdown(): Promise<void> {
    this.pool.shutdown();
  }

  // ── Discovery ────────────────────────────────────────────────────────

  async searchSymbols(query: string, limit = 20): Promise<SymbolRef[]> {
    const rows = this.instrumentCache.length > 0 ? this.instrumentCache : await loadInstruments(this.cfg.scripMasterUrl);
    return searchInstruments(rows, query, limit).map((r) => toSymbolRef(this.id, r));
  }

  async listSymbols(filter?: { segment?: string }): Promise<InstrumentMeta[]> {
    const rows = this.instrumentCache.length > 0 ? this.instrumentCache : await loadInstruments(this.cfg.scripMasterUrl);
    const out = rows.map((r) => toInstrumentMeta(this.id, r));
    if (!filter?.segment) return out;
    const seg = filter.segment.toLowerCase();
    return out.filter((m) => m.segment === seg);
  }

  async getInstrumentMeta(symbol: string): Promise<InstrumentMeta | null> {
    const ins = findInstrument(symbol);
    if (!ins) return null;
    return toInstrumentMeta(this.id, ins);
  }

  // ── Snapshots ────────────────────────────────────────────────────────

  async getCandles(symbol: string, interval: string, opts: { limit?: number; startTime?: number; endTime?: number } = {}): Promise<Candle[]> {
    const ins = findInstrument(symbol);
    if (!ins) return [];
    return fetchCandles(this.client, ins, interval, opts);
  }

  async getOrderBook(symbol: string): Promise<OrderBookSnapshot | null> {
    const ins = findInstrument(symbol);
    if (!ins) return null;
    return fetchMarketDepth(this.client, ins);
  }

  // ── Streams ──────────────────────────────────────────────────────────

  streamCandles(): Unsub {
    // Dhan v2 has no candle WS stream — clients should poll for live candles.
    // The orchestrator will still publish a snapshot on subscribe via getCandles().
    return () => undefined;
  }

  streamDepth(symbol: string, onDelta: (d: DepthDelta) => void): Unsub {
    const ins = findInstrument(symbol);
    if (!ins) return () => undefined;
    let counter = 0;
    return this.pool.subscribe(
      { exchangeSegment: ins.exchangeSegment, securityId: ins.securityId },
      (tick: DhanTick) => {
        if (!tick.bids || !tick.asks) return; // only Full packets carry depth
        counter += 1;
        const bids = tick.bids.filter(([p]) => Number.isFinite(p) && p > 0);
        const asks = tick.asks.filter(([p]) => Number.isFinite(p) && p > 0);
        onDelta({
          firstUpdateId: counter,
          finalUpdateId: counter,
          bids,
          asks,
          ts: tick.ts,
          replacement: true,
        });
      },
    );
  }

  streamTrades(symbol: string, onTrade: (t: Trade) => void): Unsub {
    const ins = findInstrument(symbol);
    if (!ins) return () => undefined;
    let lastLtt: number | undefined;
    return this.pool.subscribe(
      { exchangeSegment: ins.exchangeSegment, securityId: ins.securityId },
      (tick: DhanTick) => {
        if (typeof tick.ltp !== 'number') return;
        if (typeof tick.ltt === 'number' && tick.ltt === lastLtt) return;
        lastLtt = tick.ltt;
        onTrade({
          price: tick.ltp,
          qty: tick.ltq ?? 0,
          ts: tick.ltt ? tick.ltt * 1000 : tick.ts,
          makerSide: false,
        });
      },
    );
  }

  streamBookTicker(symbol: string, onTicker: (t: BookTicker) => void): Unsub {
    const ins = findInstrument(symbol);
    if (!ins) return () => undefined;
    return this.pool.subscribe(
      { exchangeSegment: ins.exchangeSegment, securityId: ins.securityId },
      (tick: DhanTick) => {
        const bid = tick.bids?.[0];
        const ask = tick.asks?.[0];
        if (!bid || !ask) return;
        onTicker({
          bestBidPrice: bid[0],
          bestBidQty: bid[1],
          bestAskPrice: ask[0],
          bestAskQty: ask[1],
          ts: tick.ts,
        });
      },
    );
  }
}
