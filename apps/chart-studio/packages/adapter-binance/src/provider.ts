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
import type { BinanceConfig } from './rest';
import {
  fetchDepthSnapshot,
  fetchKlines,
  loadExchangeInfo,
  toInstrumentMeta,
  toSymbolRef,
} from './rest';
import { BinanceStreamPool, parseKlineEvent } from './ws';

interface DepthRaw { U?: number; u?: number; pu?: number; E?: number; b?: [string, string][]; a?: [string, string][] }
interface AggTradeRaw { p?: string; q?: string; T?: number; m?: boolean; a?: number }
interface BookTickerRaw { u?: number; b?: string; B?: string; a?: string; A?: string }

const segmentLabel = (cfg: BinanceConfig): string => (cfg.product === 'spot' ? 'spot' : 'futures');

export class BinanceProvider implements MarketDataProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly pool: BinanceStreamPool;

  constructor(private readonly cfg: BinanceConfig & { id?: string; displayName?: string }) {
    this.id = cfg.id ?? (cfg.product === 'spot' ? 'binance-spot' : 'binance-usdm');
    this.displayName = cfg.displayName ?? (cfg.product === 'spot' ? 'Binance Spot' : 'Binance USD-M Futures');
    this.pool = new BinanceStreamPool(cfg);
  }

  async init(): Promise<void> {
    // Preload exchange info so first-symbol-search is fast.
    await loadExchangeInfo(this.cfg, this.id).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.pool.shutdown();
  }

  // ── Discovery ────────────────────────────────────────────────────────

  async searchSymbols(query: string, limit = 20): Promise<SymbolRef[]> {
    const symbols = await loadExchangeInfo(this.cfg, this.id);
    const q = query.trim().toUpperCase();
    const seg = segmentLabel(this.cfg);
    if (!q) return symbols.slice(0, limit).map((s) => toSymbolRef(this.id, seg, s));
    const matches: SymbolRef[] = [];
    for (const s of symbols) {
      const sym = s.symbol.toUpperCase();
      if (sym.includes(q)) matches.push(toSymbolRef(this.id, seg, s));
      if (matches.length >= limit) break;
    }
    return matches;
  }

  async listSymbols(): Promise<InstrumentMeta[]> {
    const symbols = await loadExchangeInfo(this.cfg, this.id);
    const seg = segmentLabel(this.cfg);
    return symbols.map((s) => toInstrumentMeta(this.id, seg, s));
  }

  async getInstrumentMeta(symbol: string): Promise<InstrumentMeta | null> {
    const symbols = await loadExchangeInfo(this.cfg, this.id);
    const sym = symbol.toUpperCase();
    const match = symbols.find((s) => s.symbol.toUpperCase() === sym);
    if (!match) return null;
    return toInstrumentMeta(this.id, segmentLabel(this.cfg), match);
  }

  // ── Snapshots ────────────────────────────────────────────────────────

  getCandles(symbol: string, interval: string, opts: { limit?: number; startTime?: number; endTime?: number } = {}): Promise<Candle[]> {
    return fetchKlines(this.cfg, symbol, interval, opts);
  }

  getOrderBook(symbol: string, limit = 100): Promise<OrderBookSnapshot | null> {
    return fetchDepthSnapshot(this.cfg, symbol, limit);
  }

  // ── Streams ──────────────────────────────────────────────────────────

  streamCandles(symbol: string, interval: string, onCandle: (c: Candle, isFinal: boolean) => void): Unsub {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    return this.pool.subscribe(stream, (raw) => {
      const ev = parseKlineEvent(raw);
      if (ev) onCandle(ev.candle, ev.isFinal);
    });
  }

  streamDepth(symbol: string, onDelta: (d: DepthDelta) => void): Unsub {
    const speed = this.cfg.product === 'spot' ? '' : '@100ms';
    const stream = `${symbol.toLowerCase()}@depth${speed}`;
    return this.pool.subscribe(stream, (raw) => {
      const r = raw as DepthRaw;
      if (typeof r.U !== 'number' || typeof r.u !== 'number') return;
      const bids = (r.b ?? []).map(([p, q]) => [Number(p), Number(q)] as [number, number]);
      const asks = (r.a ?? []).map(([p, q]) => [Number(p), Number(q)] as [number, number]);
      const delta: DepthDelta = {
        firstUpdateId: r.U,
        finalUpdateId: r.u,
        bids,
        asks,
        ts: typeof r.E === 'number' ? r.E : Date.now(),
        ...(typeof r.pu === 'number' ? { prevUpdateId: r.pu } : {}),
      };
      onDelta(delta);
    });
  }

  streamTrades(symbol: string, onTrade: (t: Trade) => void): Unsub {
    const stream = `${symbol.toLowerCase()}@aggTrade`;
    return this.pool.subscribe(stream, (raw) => {
      const r = raw as AggTradeRaw;
      const price = Number(r.p);
      const qty = Number(r.q);
      const ts = Number(r.T);
      if (![price, qty, ts].every(Number.isFinite)) return;
      onTrade({ price, qty, ts, makerSide: Boolean(r.m), tradeId: r.a });
    });
  }

  streamBookTicker(symbol: string, onTicker: (t: BookTicker) => void): Unsub {
    const stream = `${symbol.toLowerCase()}@bookTicker`;
    return this.pool.subscribe(stream, (raw) => {
      const r = raw as BookTickerRaw;
      const bp = Number(r.b);
      const bq = Number(r.B);
      const ap = Number(r.a);
      const aq = Number(r.A);
      if (![bp, bq, ap, aq].every(Number.isFinite)) return;
      onTicker({ bestBidPrice: bp, bestBidQty: bq, bestAskPrice: ap, bestAskQty: aq, ts: Date.now() });
    });
  }
}
