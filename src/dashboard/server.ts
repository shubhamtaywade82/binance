/**
 * Live Trading Dashboard — WebSocket Bridge Server
 * Streams live Binance market data and strategy signals to browser clients.
 * Port: 4000
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, binanceWsBase, ollamaApiUrl } from '../config';
import { BinanceMultiplexWs, type AggTradeEvent, type BookTickerEvent, type DepthPartialEvent } from '../binance/ws-multiplex';
import { MultiTimeframeStore } from '../binance/multi-tf-store';
import { LocalOrderBook } from '../binance/orderbook';
import { AggTradeTape } from '../binance/trade-tape';
import { fetchBinanceKlines } from '../binance/rest-klines';
import { biasFromCandles } from '../strategy/htf-ltf';
import { analyzeTrend } from '../strategy/trend';
import { analyzeSmc } from '../strategy/smc';
import { evaluateSolMtfStrategy } from '../strategy/sol-mtf-strategy';
import { ema, rsi, macd, supertrend } from '../strategy/indicators';
import type { Candle } from '../types';
import { requestMarketBrief, type MarketSignalsSnapshot } from '../ai/market-brief';

const cfg = loadConfig();
const PORT = 4001;
const SYMBOL = cfg.BINANCE_SYMBOL.toUpperCase();
const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
/** Cap in-memory series per timeframe (Binance lazy-load fills up to this). */
const MAX_STORE_BARS = 100_000;
/**
 * Indicators are computed on the last N bars only (MACD/EMA cost); candles carry full history.
 * Client aligns indicator series to the tail of the candle array.
 */
const INDICATOR_MAX_BARS = 3000;
/**
 * Binance emits many in-progress klines/sec. Recomputing MACD/EMA for all TFs + broadcasting on
 * every tick blocks the Node event loop so candle `kline` WS messages arrive late vs TradingView.
 * Final bars still refresh indicators immediately.
 */
const INDICATOR_BROADCAST_MIN_MS = 150;
const DEPTH_LEVELS = 20;

// ─── State ──────────────────────────────────────────────────────────────────
const store = new MultiTimeframeStore({ maxBars: MAX_STORE_BARS });
const orderbook = new LocalOrderBook();
const tradeTape = new AggTradeTape(500);

let lastMark: number | null = null;
let bestBid: number | null = null;
let bestAsk: number | null = null;

let lastAiBriefAt = 0;
let aiBriefInflight = false;
let aiBriefWarnedNoModel = false;
let aiBriefWarnedCloudKey = false;

let indicatorDebounce: ReturnType<typeof setTimeout> | null = null;

function maybeRefreshAiBrief(signals: ReturnType<typeof computeSignals>): void {
  if (!cfg.AI_MARKET_BRIEF_ENABLED) return;
  if (!cfg.OLLAMA_MODEL.trim()) {
    if (!aiBriefWarnedNoModel) {
      aiBriefWarnedNoModel = true;
      console.warn('[dashboard] AI_MARKET_BRIEF_ENABLED but OLLAMA_MODEL is empty — skipping.');
    }
    return;
  }
  if (cfg.OLLAMA_TARGET === 'cloud' && !cfg.OLLAMA_API_KEY.trim()) {
    if (!aiBriefWarnedCloudKey) {
      aiBriefWarnedCloudKey = true;
      console.warn('[dashboard] OLLAMA_TARGET=cloud but OLLAMA_API_KEY is empty — skipping AI brief.');
    }
    return;
  }
  const gapMs = cfg.AI_BRIEF_INTERVAL_SEC * 1000;
  const now = Date.now();
  if (aiBriefInflight) return;
  if (lastAiBriefAt > 0 && now - lastAiBriefAt < gapMs) return;

  const snapshot: MarketSignalsSnapshot = {
    symbol: SYMBOL,
    refPrice: signals.refPrice,
    htfBias: String(signals.htfBias),
    ltfDirection: String(signals.ltfDirection),
    ltfConfidence: signals.ltfConfidence,
    ltfScore: signals.ltfScore,
    ltfSignals: signals.ltfSignals,
    smc: signals.smc,
    solMtf: signals.solMtf,
  };

  aiBriefInflight = true;
  void requestMarketBrief(
    {
      host: ollamaApiUrl(cfg.OLLAMA_TARGET),
      model: cfg.OLLAMA_MODEL,
      apiKey: cfg.OLLAMA_API_KEY.trim() || undefined,
      timeoutMs: cfg.AI_REQUEST_TIMEOUT_MS,
    },
    snapshot,
  ).then((r) => {
    aiBriefInflight = false;
    lastAiBriefAt = Date.now();
    if (r.text) {
      broadcast({ type: 'ai_brief', text: r.text, ts: Date.now() });
    } else if (r.error) {
      broadcast({ type: 'ai_brief', error: r.error, ts: Date.now() });
    }
  });
}

// ─── HTTP + WS Server ────────────────────────────────────────────────────────
const httpServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Trading Dashboard WS Bridge v1.0\n');
});

const wss = new WebSocketServer({ server: httpServer });

function broadcast(msg: object): void {
  const raw = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

const historyLoadInflight = new Set<string>();

async function handleClientLoadHistory(ws: WebSocket, tf: string, oldestOpenTime: number): Promise<void> {
  if (!TIMEFRAMES.includes(tf)) return;
  if (!Number.isFinite(oldestOpenTime) || oldestOpenTime < 1) {
    ws.send(JSON.stringify({ type: 'history_error', tf, error: 'invalid oldestOpenTime' }));
    return;
  }
  if (historyLoadInflight.has(tf)) {
    ws.send(JSON.stringify({ type: 'history_busy', tf }));
    return;
  }
  historyLoadInflight.add(tf);
  try {
    const endTime = Math.floor(oldestOpenTime) - 1;
    const bars = await fetchBinanceKlines(cfg, {
      symbol: SYMBOL,
      interval: tf,
      limit: 1500,
      endTime,
    });
    const older = bars.filter((c) => c.openTime < oldestOpenTime);
    if (older.length === 0) {
      broadcast({ type: 'history_end', tf });
      return;
    }
    store.prependOlder(SYMBOL, tf, older);
    const c5m = store.getSeries(SYMBOL, '5m');
    const c15m = store.getSeries(SYMBOL, '15m');
    const c1h = store.getSeries(SYMBOL, '1h');
    const c4h = store.getSeries(SYMBOL, '4h');
    const c1d = store.getSeries(SYMBOL, '1d');
    broadcast({ type: 'history_chunk', tf, candles: older });
    broadcast({ type: 'indicators', ...computeIndicators(c5m, c15m, c1h, c4h, c1d) });
  } catch (e) {
    ws.send(
      JSON.stringify({ type: 'history_error', tf, error: (e as Error).message }),
    );
  } finally {
    historyLoadInflight.delete(tf);
  }
}

wss.on('connection', (ws) => {
  console.log(`[dashboard] client connected (total: ${wss.clients.size})`);

  // Send current snapshot on connect
  const snap = buildSnapshot();
  ws.send(JSON.stringify({ type: 'snapshot', ...snap }));

  ws.on('message', (raw) => {
    let msg: { type?: string; tf?: string; oldestOpenTime?: number };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== 'load_history' || typeof msg.tf !== 'string') return;
    const oldest = Number(msg.oldestOpenTime);
    void handleClientLoadHistory(ws, msg.tf, oldest);
  });

  ws.on('close', () => {
    console.log(`[dashboard] client disconnected (total: ${wss.clients.size})`);
  });
  ws.on('error', (e) => console.warn('[dashboard] client error:', e.message));
});

// ─── Snapshot Builder ────────────────────────────────────────────────────────
function buildSnapshot() {
  const candles5m = store.getSeries(SYMBOL, '5m');
  const candles15m = store.getSeries(SYMBOL, '15m');
  const candles1h = store.getSeries(SYMBOL, '1h');
  const candles4h = store.getSeries(SYMBOL, '4h');
  const candles1d = store.getSeries(SYMBOL, '1d');

  return {
    symbol: SYMBOL,
    mark: lastMark,
    bestBid,
    bestAsk,
    candles: {
      '5m': candles5m,
      '15m': candles15m,
      '1h': candles1h,
      '4h': candles4h,
      '1d': candles1d,
    },
    depth: orderbook.topLevels(DEPTH_LEVELS),
    trades: tradeTape.recent(60),
    indicators: computeIndicators(candles5m, candles15m, candles1h, candles4h, candles1d),
    signals: computeSignals(),
  };
}

// ─── Indicator Computation ───────────────────────────────────────────────────
/** JSON-safe numbers (NaN → null) so the client keeps index alignment with candles. */
function finiteSeries(arr: number[]): (number | null)[] {
  return arr.map((v) => (Number.isFinite(v) ? v : null));
}

/** One chart timeframe: EMA / RSI / MACD / supertrend aligned to `candles` length. */
function chartIndicatorBundle(candles: Candle[]) {
  if (candles.length < 2) return null;
  const closes = candles.map((c) => c.close);
  const m = macd(closes);
  const st = supertrend(candles, 10, 3);
  return {
    ema9: finiteSeries(ema(closes, 9)),
    ema21: finiteSeries(ema(closes, 21)),
    ema50: finiteSeries(ema(closes, 50)),
    rsi: finiteSeries(rsi(closes, 14)),
    macdHist: finiteSeries(m.hist),
    macdLine: finiteSeries(m.macd),
    macdSignal: finiteSeries(m.signal),
    supertrend: {
      value: finiteSeries(st.value),
      dir: st.dir,
    },
  };
}

type ChartTfBundle = NonNullable<ReturnType<typeof chartIndicatorBundle>>;

function computeIndicators(
  c5m: Candle[],
  c15m: Candle[],
  c1h: Candle[],
  c4h: Candle[],
  c1d: Candle[],
): Record<string, ChartTfBundle> {
  const out: Record<string, ChartTfBundle> = {};
  for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
    const series =
      tf === '5m'
        ? c5m
        : tf === '15m'
          ? c15m
          : tf === '1h'
            ? c1h
            : tf === '4h'
              ? c4h
              : c1d;
    const tail = series.length <= INDICATOR_MAX_BARS ? series : series.slice(-INDICATOR_MAX_BARS);
    const bundle = chartIndicatorBundle(tail);
    if (bundle) out[tf] = bundle;
  }
  return out;
}

function broadcastLatestIndicators(): void {
  const c5m = store.getSeries(SYMBOL, '5m');
  const c15m = store.getSeries(SYMBOL, '15m');
  const c1h = store.getSeries(SYMBOL, '1h');
  const c4h = store.getSeries(SYMBOL, '4h');
  const c1d = store.getSeries(SYMBOL, '1d');
  broadcast({ type: 'indicators', ...computeIndicators(c5m, c15m, c1h, c4h, c1d) });
}

/** Partial klines: trailing debounce. Final kline: flush immediately. */
function scheduleIndicatorBroadcast(isFinal: boolean): void {
  const flush = (): void => {
    indicatorDebounce = null;
    broadcastLatestIndicators();
  };

  if (isFinal) {
    if (indicatorDebounce != null) {
      clearTimeout(indicatorDebounce);
      indicatorDebounce = null;
    }
    flush();
    return;
  }

  if (indicatorDebounce != null) clearTimeout(indicatorDebounce);
  indicatorDebounce = setTimeout(flush, INDICATOR_BROADCAST_MIN_MS);
}

// ─── Signal Computation ──────────────────────────────────────────────────────
function computeSignals() {
  const candles5m = store.getSeries(SYMBOL, '5m');
  const candles15m = store.getSeries(SYMBOL, '15m');
  const candles1h = store.getSeries(SYMBOL, '1h');
  const candles4h = store.getSeries(SYMBOL, '4h');
  const candles1d = store.getSeries(SYMBOL, '1d');

  const refPrice = lastMark ?? candles5m[candles5m.length - 1]?.close ?? 0;

  const htfBias = biasFromCandles(candles1h);
  const ltfTrend = analyzeTrend(candles5m);
  const smc = analyzeSmc(candles5m, refPrice, htfBias);

  let solMtf = null;
  if (candles5m.length >= 30 && candles1d.length >= 22) {
    try {
      solMtf = evaluateSolMtfStrategy({
        candles: {
          '1d': candles1d,
          '4h': candles4h,
          '1h': candles1h,
          '15m': candles15m,
          '5m': candles5m,
        },
        refPrice,
        minConfidence: cfg.MIN_CONFIDENCE,
      });
    } catch { /* insufficient bars */ }
  }

  return {
    refPrice,
    htfBias,
    ltfDirection: ltfTrend.direction,
    ltfConfidence: +ltfTrend.confidence.toFixed(3),
    ltfScore: ltfTrend.score,
    ltfSignals: ltfTrend.signals,
    smc: {
      score: smc.score,
      liquiditySweep: smc.liquiditySweep,
      orderBlock: smc.orderBlock,
      fvg: smc.fvg,
      bos: smc.bos,
      choch: smc.choch,
    },
    solMtf: solMtf
      ? { pass: solMtf.pass, direction: solMtf.direction, reasons: solMtf.reasons }
      : null,
  };
}

// ─── Binance Multiplex Feed ───────────────────────────────────────────────────
const multiplex = new BinanceMultiplexWs(
  {
    baseWsUrl: binanceWsBase(cfg),
    symbols: [SYMBOL],
    timeframes: TIMEFRAMES,
    product: cfg.BINANCE_PRODUCT,
    useBookTicker: true,
    useAggTrade: true,
    depthLevels: DEPTH_LEVELS as 20,
    depthSpeed: '100ms',
    useMarkPrice: true,
    reconnectAfterHours: 23,
  },
  {
    onOpen: (route, url) => {
      console.log(`[dashboard] Binance WS connected — ${url ?? route ?? 'unknown'}`);
      broadcast({ type: 'status', connected: true, symbol: SYMBOL });
    },

    onError: (e) => {
      console.warn('[dashboard] Binance WS error:', e.message);
      broadcast({ type: 'status', connected: false, error: e.message });
    },

    onReconnect: (n, reason) => {
      console.warn(`[dashboard] reconnect #${n}: ${reason}`);
      broadcast({ type: 'status', reconnecting: true, attempt: n });
    },

    onServerShutdown: () => {
      console.warn('[dashboard] Binance server shutdown');
    },

    onKline: (sym, tf, candle, isFinal) => {
      if (sym.toUpperCase() !== SYMBOL) return;
      store.applyKline(sym, tf, candle, isFinal);

      broadcast({ type: 'kline', tf, candle, isFinal });

      if (['5m', '15m', '1h', '4h', '1d'].includes(tf)) {
        scheduleIndicatorBroadcast(isFinal);
      }

      if (isFinal && (tf === '5m' || tf === '15m')) {
        const signals = computeSignals();
        broadcast({ type: 'signals', ...signals });
        void maybeRefreshAiBrief(signals);
      }
    },

    onMarkPrice: (u) => {
      if (u.symbol.toUpperCase() !== SYMBOL) return;
      lastMark = u.markPrice;
      broadcast({ type: 'mark_price', price: u.markPrice, ts: u.eventTime });
    },

    on24hrTicker: (u) => {
      if (u.symbol.toUpperCase() !== SYMBOL) return;
      lastMark = lastMark ?? u.lastPrice;
      broadcast({
        type: 'ticker_24hr',
        price: u.lastPrice,
        ts: u.eventTime,
      });
    },

    onBookTicker: (t: BookTickerEvent) => {
      if (t.symbol.toUpperCase() !== SYMBOL) return;
      bestBid = t.bestBid;
      bestAsk = t.bestAsk;
      broadcast({
        type: 'book_ticker',
        bid: t.bestBid,
        ask: t.bestAsk,
        spread: t.bestAsk - t.bestBid,
        ts: t.ts,
      });
    },

    onAggTrade: (t: AggTradeEvent) => {
      if (t.symbol.toUpperCase() !== SYMBOL) return;
      const trade = { price: t.price, qty: t.qty, ts: t.ts, makerSide: t.makerSide };
      tradeTape.push(trade);
      broadcast({ type: 'agg_trade', ...trade });
    },

    onDepthDiff: () => {
      // We use partial depth (depth levels), not diff stream
    },

    onDepthPartial: (p: DepthPartialEvent) => {
      const symU = SYMBOL;
      if (p.symbol && p.symbol.toUpperCase() !== symU) return;
      orderbook.replaceFromPartial({ bids: p.bids, asks: p.asks });
      const levels = orderbook.topLevels(DEPTH_LEVELS);
      broadcast({ type: 'depth', bids: levels.bids, asks: levels.asks });
    },
  },
);

// ─── Seed Historical Candles ─────────────────────────────────────────────────
async function seedHistory(): Promise<void> {
  console.log('[dashboard] Seeding historical candles...');
  await Promise.allSettled(
    TIMEFRAMES.map(async (tf) => {
      const limit = 1500;
      try {
        const bars = await fetchBinanceKlines(cfg, { symbol: SYMBOL, interval: tf, limit });
        store.seed(SYMBOL, tf, bars);
        console.log(`[dashboard] seeded ${bars.length} ${tf} bars`);
      } catch (e) {
        console.warn(`[dashboard] seed failed ${tf}:`, (e as Error).message);
      }
    }),
  );
  console.log('[dashboard] Historical candles ready.');
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────
setInterval(() => {
  broadcast({ type: 'heartbeat', ts: Date.now(), clients: wss.clients.size });
}, 10_000);

// ─── Signal refresh every minute (fallback) ──────────────────────────────────
setInterval(() => {
  const signals = computeSignals();
  broadcast({ type: 'signals', ...signals });
  void maybeRefreshAiBrief(signals);
}, 60_000);

// ─── Start ───────────────────────────────────────────────────────────────────
(async () => {
  await seedHistory();
  multiplex.start();

  const bootSignals = computeSignals();
  void maybeRefreshAiBrief(bootSignals);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Dashboard WS Bridge on ws://0.0.0.0:${PORT} (all interfaces)`);
    console.log(`   Symbol: ${SYMBOL} | Timeframes: ${TIMEFRAMES.join(', ')}`);
    console.log(`   UI: npm run ui:dev → http://localhost:5173\n`);
  });
})();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[dashboard] Shutting down...');
  await multiplex.stop();
  httpServer.close();
  process.exit(0);
});
