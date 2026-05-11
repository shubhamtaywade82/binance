/**
 * Live Trading Dashboard — WebSocket Bridge Server
 * Streams live Binance market data and strategy signals to browser clients.
 * Port: 4000
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, binanceWsBase } from '../config';
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

const cfg = loadConfig();
const PORT = 4001;
const SYMBOL = cfg.BINANCE_SYMBOL.toUpperCase();
const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
const DEPTH_LEVELS = 20;

// ─── State ──────────────────────────────────────────────────────────────────
const store = new MultiTimeframeStore({ maxBars: 1000 });
const orderbook = new LocalOrderBook();
const tradeTape = new AggTradeTape(500);

let lastMark: number | null = null;
let bestBid: number | null = null;
let bestAsk: number | null = null;

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

wss.on('connection', (ws) => {
  console.log(`[dashboard] client connected (total: ${wss.clients.size})`);

  // Send current snapshot on connect
  const snap = buildSnapshot();
  ws.send(JSON.stringify({ type: 'snapshot', ...snap }));

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
      '5m': candles5m.slice(-300),
      '15m': candles15m.slice(-200),
      '1h': candles1h.slice(-100),
      '4h': candles4h.slice(-60),
      '1d': candles1d.slice(-30),
    },
    depth: orderbook.topLevels(DEPTH_LEVELS),
    trades: tradeTape.recent(60),
    indicators: computeIndicators(candles5m, candles15m, candles1h),
  };
}

// ─── Indicator Computation ───────────────────────────────────────────────────
function computeIndicators(c5m: Candle[], c15m: Candle[], c1h: Candle[]) {
  const closes5m = c5m.map((c) => c.close);
  const closes15m = c15m.map((c) => c.close);
  const closes1h = c1h.map((c) => c.close);

  const ema9_5m = ema(closes5m, 9);
  const ema21_5m = ema(closes5m, 21);
  const ema50_5m = ema(closes5m, 50);
  const ema9_1h = ema(closes1h, 9);
  const ema21_1h = ema(closes1h, 21);

  const rsi14_5m = rsi(closes5m, 14);
  const rsi14_15m = rsi(closes15m, 14);

  const macd5m = macd(closes5m);
  const st5m = supertrend(c5m, 10, 3);

  const lastN = (arr: number[], n = 50) => arr.slice(-n).filter(Number.isFinite);

  return {
    '5m': {
      ema9: lastN(ema9_5m),
      ema21: lastN(ema21_5m),
      ema50: lastN(ema50_5m),
      rsi: lastN(rsi14_5m),
      macdHist: lastN(macd5m.hist),
      macdLine: lastN(macd5m.macd),
      macdSignal: lastN(macd5m.signal),
      supertrend: {
        value: lastN(st5m.value),
        dir: st5m.dir.slice(-50),
      },
    },
    '1h': {
      ema9: lastN(ema9_1h),
      ema21: lastN(ema21_1h),
    },
  };
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

      if (isFinal && (tf === '5m' || tf === '15m')) {
        // Recompute signals & indicators on each LTF close
        const signals = computeSignals();
        broadcast({ type: 'signals', ...signals });

        // Send fresh indicators
        const c5m = store.getSeries(SYMBOL, '5m');
        const c15m = store.getSeries(SYMBOL, '15m');
        const c1h = store.getSeries(SYMBOL, '1h');
        const indicators = computeIndicators(c5m, c15m, c1h);
        broadcast({ type: 'indicators', ...indicators });
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
      const limit = tf === '1d' ? 60 : tf === '4h' ? 120 : tf === '1h' ? 200 : 500;
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
}, 60_000);

// ─── Start ───────────────────────────────────────────────────────────────────
(async () => {
  await seedHistory();
  multiplex.start();

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 Dashboard WS Bridge running at ws://localhost:${PORT}`);
    console.log(`   Symbol: ${SYMBOL} | Timeframes: ${TIMEFRAMES.join(', ')}`);
    console.log(`   Open the UI at http://localhost:5173\n`);
  });
})();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[dashboard] Shutting down...');
  await multiplex.stop();
  httpServer.close();
  process.exit(0);
});
