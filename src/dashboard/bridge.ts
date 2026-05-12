/**
 * Dashboard WebSocket bridge — consumes the same in-memory feeds as {@link HybridOrchestrator}
 * (multiplex sidecar callbacks). No second Binance WebSocket.
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from '../config';
import { multiplexBinanceSymbols, ollamaApiUrl } from '../config';
import type { AggTradeEvent, BookTickerEvent, DepthPartialEvent, MultiplexCallbacks } from '../binance/ws-multiplex';
import type { MultiTimeframeStore } from '../binance/multi-tf-store';
import type { LocalOrderBook, DepthDiff } from '../binance/orderbook';
import type { AggTradeTape } from '../binance/trade-tape';
import type { PerSymbolMarketFeeds } from '../binance/per-symbol-market-feeds';
import { fetchBinanceKlines } from '../binance/rest-klines';
import { biasFromCandles } from '../strategy/htf-ltf';
import { analyzeTrend } from '../strategy/trend';
import { analyzeSmc } from '../strategy/smc';
import type { LiquidityEngineResult } from '../strategy/liquidity-engine';
import { evaluateSolMtfStrategy } from '../strategy/sol-mtf-strategy';
import { ema, rsi, macd, supertrend } from '../strategy/indicators';
import type { Candle } from '../types';
import { requestMarketBrief, type MarketSignalsSnapshot } from '../ai/market-brief';
import type { AppLogger } from '../logging/app-logger';

const CHART_TFS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
type ChartTf = (typeof CHART_TFS)[number];

const INDICATOR_MAX_BARS = 3000;
const INDICATOR_BROADCAST_MIN_MS = 150;

export interface DashboardFeeds {
  store: MultiTimeframeStore;
  orderbook: LocalOrderBook;
  tradeTape: AggTradeTape;
  /** Present when `BINANCE_WATCHLIST` adds extra multiplex symbols — per-symbol book + tape. */
  marketFeeds?: PerSymbolMarketFeeds | null;
}

export interface DashboardBridge {
  multiplexSidecar: MultiplexCallbacks;
  listen: () => Promise<void>;
  stop: () => Promise<void>;
}

/** Broadcast as `type: 'signals'`; also passed to AI brief builder. */
export interface DashboardSignalsPayload {
  refPrice: number;
  refPriceTf: string;
  htfBias: string;
  ltfDirection: string;
  ltfConfidence: number;
  ltfScore: number;
  ltfSignals: unknown;
  smc: {
    score: number;
    liquiditySweep: string;
    /** `index` = bar offset in `refPriceTf` series (chart maps to time). */
    orderBlock: { type: string; low: number; high: number; index: number } | null;
    /** Fair value gap zone + anchor bar index (C3 in SMC scan). */
    fvg: { type: string; low: number; high: number; index: number } | null;
    bos: string;
    choch: string;
    liquidity: LiquidityEngineResult | null;
  };
  solMtf: { pass: boolean; direction: string; reasons: string[] } | null;
  signalMeta: { trendSeriesTf: string; htf: string; executionLtf: string };
}

export function createDashboardBridge(cfg: AppConfig, log: AppLogger, feeds: DashboardFeeds): DashboardBridge {
  const { store, orderbook, tradeTape, marketFeeds = null } = feeds;
  const symbolUpper = cfg.BINANCE_SYMBOL.trim().toUpperCase();
  const watchlistSymbols = multiplexBinanceSymbols(cfg);
  const watchlistSet = new Set(watchlistSymbols);

  function obFor(sym: string): LocalOrderBook {
    return marketFeeds?.book(sym) ?? orderbook;
  }

  function tapeFor(sym: string): AggTradeTape {
    return marketFeeds?.tape(sym) ?? tradeTape;
  }
  const allowedHistoryTfs = new Set(cfg.BINANCE_TIMEFRAMES);
  const chartTfsOnStream = CHART_TFS.filter((tf) => cfg.BINANCE_TIMEFRAMES.includes(tf));
  const chartTfBroadcastSet = new Set<string>(chartTfsOnStream);
  const ltfTf = cfg.BINANCE_TIMEFRAMES[0] ?? '5m';
  const htfTf = cfg.BINANCE_TIMEFRAMES[1] ?? cfg.BINANCE_HTF_INTERVAL;
  const depthLevelsUi = cfg.BINANCE_DEPTH_LEVELS > 0 ? cfg.BINANCE_DEPTH_LEVELS : 20;
  /** SMC sweep logic needs ~22 bars on the series passed in. */
  const SMC_MIN_BARS = 22;

  /** Per-dashboard-client chart TF — drives ref price + trend + SMC series for that browser only. */
  const refTfByClient = new Map<WebSocket, string>();
  /** Per-client symbol from the multiplex watchlist (defaults to execution / primary symbol). */
  const watchSymbolByClient = new Map<WebSocket, string>();

  const lastMarkBySym = new Map<string, number>();
  const lastBookBySym = new Map<string, { bid: number; ask: number }>();

  let lastAiBriefAt = 0;
  let aiBriefInflight = false;
  let aiBriefWarnedNoModel = false;
  let aiBriefWarnedCloudKey = false;

  const indicatorDebounceBySym = new Map<string, ReturnType<typeof setTimeout>>();

  function getSym(client: WebSocket): string {
    return watchSymbolByClient.get(client) ?? symbolUpper;
  }

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Trading bot — dashboard WebSocket (same process as orchestrator)\n');
  });

  const wss = new WebSocketServer({ server: httpServer });
  const historyLoadInflight = new Set<string>();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let signalsTimer: ReturnType<typeof setInterval> | null = null;

  function broadcast(msg: object): void {
    const raw = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  }

  function getCandlesByChartTf(sym: string): Record<ChartTf, Candle[]> {
    const out = {} as Record<ChartTf, Candle[]>;
    for (const tf of CHART_TFS) {
      out[tf] = store.getSeries(sym, tf);
    }
    return out;
  }

  function defaultChartRefTf(): string {
    if (chartTfBroadcastSet.has(ltfTf)) return ltfTf;
    return chartTfsOnStream[0] ?? ltfTf;
  }

  function firstOpenWebSocket(): WebSocket | undefined {
    for (const c of wss.clients) {
      if (c.readyState === WebSocket.OPEN) return c;
    }
    return undefined;
  }

  function broadcastSignalsPerClient(): void {
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const tf = refTfByClient.get(client) ?? defaultChartRefTf();
      const payload = computeSignalsForClient(client, tf);
      client.send(JSON.stringify({ type: 'signals', ...payload }));
    }
  }

  function maybeRefreshAiBrief(signals: DashboardSignalsPayload, watchSymbol: string): void {
    if (!cfg.AI_MARKET_BRIEF_ENABLED) return;
    if (!cfg.OLLAMA_MODEL.trim()) {
      if (!aiBriefWarnedNoModel) {
        aiBriefWarnedNoModel = true;
        log.warn('dashboard_ai_brief_skipped', { reason: 'OLLAMA_MODEL empty' });
      }
      return;
    }
    if (cfg.OLLAMA_TARGET === 'cloud' && !cfg.OLLAMA_API_KEY.trim()) {
      if (!aiBriefWarnedCloudKey) {
        aiBriefWarnedCloudKey = true;
        log.warn('dashboard_ai_brief_skipped', { reason: 'OLLAMA_TARGET=cloud but OLLAMA_API_KEY empty' });
      }
      return;
    }
    const gapMs = cfg.AI_BRIEF_INTERVAL_SEC * 1000;
    const now = Date.now();
    if (aiBriefInflight) return;
    if (lastAiBriefAt > 0 && now - lastAiBriefAt < gapMs) return;

    const snapshot: MarketSignalsSnapshot = {
      symbol: watchSymbol,
      refPrice: signals.refPrice,
      refPriceTf: signals.refPriceTf,
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

  function finiteSeries(arr: number[]): (number | null)[] {
    return arr.map((v) => (Number.isFinite(v) ? v : null));
  }

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

  function computeIndicatorsFromRows(rows: Record<ChartTf, Candle[]>): Record<string, ChartTfBundle> {
    const out: Record<string, ChartTfBundle> = {};
    for (const tf of CHART_TFS) {
      const series = rows[tf];
      const tail = series.length <= INDICATOR_MAX_BARS ? series : series.slice(-INDICATOR_MAX_BARS);
      const bundle = chartIndicatorBundle(tail);
      if (bundle) out[tf] = bundle;
    }
    return out;
  }

  function broadcastLatestIndicatorsForSymbol(sym: string): void {
    const rows = getCandlesByChartTf(sym);
    const payload = { type: 'indicators', ...computeIndicatorsFromRows(rows) };
    const raw = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (getSym(client) !== sym) continue;
      client.send(raw);
    }
  }

  function scheduleIndicatorBroadcastForSymbol(sym: string, isFinal: boolean): void {
    const flush = (): void => {
      indicatorDebounceBySym.delete(sym);
      broadcastLatestIndicatorsForSymbol(sym);
    };

    if (isFinal) {
      const pending = indicatorDebounceBySym.get(sym);
      if (pending !== undefined) {
        clearTimeout(pending);
        indicatorDebounceBySym.delete(sym);
      }
      flush();
      return;
    }

    const existing = indicatorDebounceBySym.get(sym);
    if (existing !== undefined) clearTimeout(existing);
    indicatorDebounceBySym.set(sym, setTimeout(flush, INDICATOR_BROADCAST_MIN_MS));
  }

  function refPriceFromTf(sym: string, tf: string): number | undefined {
    const s = store.getSeries(sym, tf);
    const c = s[s.length - 1]?.close;
    return Number.isFinite(c) ? c : undefined;
  }

  function computeSignalsForSymbol(sym: string, requestedTf: string): DashboardSignalsPayload {
    const rows = getCandlesByChartTf(sym);
    const candlesLtf = store.getSeries(sym, ltfTf);
    const candlesHtf = store.getSeries(sym, htfTf);
    const effectiveTf = chartTfBroadcastSet.has(requestedTf) ? requestedTf : defaultChartRefTf();
    const refSeries = store.getSeries(sym, effectiveTf);

    const candlesTrend = refSeries.length >= 2 ? refSeries : candlesLtf;
    const candlesSmc = refSeries.length >= SMC_MIN_BARS ? refSeries : candlesLtf;

    const lastMark = lastMarkBySym.get(sym);
    const refPrice =
      refPriceFromTf(sym, effectiveTf) ??
      refPriceFromTf(sym, ltfTf) ??
      (typeof lastMark === 'number' && Number.isFinite(lastMark) ? lastMark : undefined) ??
      0;

    const htfBiasRaw = biasFromCandles(candlesHtf);
    const ltfTrend = analyzeTrend(candlesTrend);
    const smc = analyzeSmc(candlesSmc, refPrice, htfBiasRaw, { timeframe: effectiveTf });

    let solMtf = null;
    const c5 = rows['5m'];
    const c1d = rows['1d'];
    if (c5.length >= 30 && c1d.length >= 22) {
      try {
        solMtf = evaluateSolMtfStrategy({
          candles: {
            '1d': rows['1d'],
            '4h': rows['4h'],
            '1h': rows['1h'],
            '15m': rows['15m'],
            '5m': rows['5m'],
          },
          refPrice,
          minConfidence: cfg.MIN_CONFIDENCE,
        });
      } catch {
        /* insufficient bars */
      }
    }

    return {
      refPrice,
      refPriceTf: effectiveTf,
      htfBias: String(htfBiasRaw),
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
        liquidity: smc.liquidity,
      },
      solMtf: solMtf ? { pass: solMtf.pass, direction: solMtf.direction, reasons: solMtf.reasons } : null,
      signalMeta: {
        trendSeriesTf: effectiveTf,
        htf: htfTf,
        executionLtf: ltfTf,
      },
    };
  }

  function computeSignalsForClient(client: WebSocket, requestedTf: string): DashboardSignalsPayload {
    return computeSignalsForSymbol(getSym(client), requestedTf);
  }

  function buildSnapshot(forWs: WebSocket): Record<string, unknown> {
    const sym = getSym(forWs);
    const rows = getCandlesByChartTf(sym);
    const refTf = refTfByClient.get(forWs) ?? defaultChartRefTf();
    const signals = computeSignalsForClient(forWs, refTf);
    const book = lastBookBySym.get(sym);
    const mark = lastMarkBySym.get(sym);
    return {
      symbol: sym,
      watchlist: watchlistSymbols,
      executionSymbol: symbolUpper,
      availableTimeframes: [...chartTfsOnStream],
      mark: mark !== undefined ? mark : null,
      bestBid: book?.bid ?? null,
      bestAsk: book?.ask ?? null,
      candles: {
        '1m': rows['1m'],
        '5m': rows['5m'],
        '15m': rows['15m'],
        '1h': rows['1h'],
        '4h': rows['4h'],
        '1d': rows['1d'],
      },
      depth: obFor(sym).topLevels(depthLevelsUi),
      trades: tapeFor(sym).recent(60),
      indicators: computeIndicatorsFromRows(rows),
      signals,
    };
  }

  async function handleClientLoadHistory(ws: WebSocket, tf: string, oldestOpenTime: number): Promise<void> {
    if (!allowedHistoryTfs.has(tf)) return;
    if (!Number.isFinite(oldestOpenTime) || oldestOpenTime < 1) {
      ws.send(JSON.stringify({ type: 'history_error', tf, error: 'invalid oldestOpenTime' }));
      return;
    }
    const sym = getSym(ws);
    const inflightKey = `${sym}|${tf}`;
    if (historyLoadInflight.has(inflightKey)) {
      ws.send(JSON.stringify({ type: 'history_busy', tf, symbol: sym }));
      return;
    }
    historyLoadInflight.add(inflightKey);
    try {
      const endTime = Math.floor(oldestOpenTime) - 1;
      const bars = await fetchBinanceKlines(cfg, {
        symbol: sym,
        interval: tf,
        limit: 1500,
        endTime,
      });
      const older = bars.filter((c) => c.openTime < oldestOpenTime);
      if (older.length === 0) {
        const endRaw = JSON.stringify({ type: 'history_end', tf, symbol: sym });
        for (const client of wss.clients) {
          if (client.readyState !== WebSocket.OPEN) continue;
          if (getSym(client) !== sym) continue;
          client.send(endRaw);
        }
        return;
      }
      store.prependOlder(sym, tf, older);
      const chunkRaw = JSON.stringify({ type: 'history_chunk', symbol: sym, tf, candles: older });
      const indRaw = JSON.stringify({
        type: 'indicators',
        ...computeIndicatorsFromRows(getCandlesByChartTf(sym)),
      });
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (getSym(client) !== sym) continue;
        client.send(chunkRaw);
        client.send(indRaw);
        const tf0 = refTfByClient.get(client) ?? defaultChartRefTf();
        client.send(JSON.stringify({ type: 'signals', ...computeSignalsForClient(client, tf0) }));
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'history_error', tf, symbol: sym, error: (e as Error).message }));
    } finally {
      historyLoadInflight.delete(inflightKey);
    }
  }

  wss.on('connection', (ws) => {
    log.info('dashboard_client_connected', { clients: wss.clients.size });
    refTfByClient.set(ws, defaultChartRefTf());
    watchSymbolByClient.set(ws, symbolUpper);
    const snap = buildSnapshot(ws);
    ws.send(JSON.stringify({ type: 'snapshot', ...snap }));

    ws.on('message', (raw) => {
      let msg: { type?: string; tf?: string; oldestOpenTime?: number; symbol?: string };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'set_watch_symbol' && typeof msg.symbol === 'string') {
        const next = msg.symbol.trim().toUpperCase();
        if (watchlistSet.has(next)) {
          watchSymbolByClient.set(ws, next);
          ws.send(JSON.stringify({ type: 'snapshot', ...buildSnapshot(ws) }));
        }
        return;
      }
      if (msg.type === 'set_chart_tf' && typeof msg.tf === 'string') {
        const tf = msg.tf.trim().toLowerCase();
        if (chartTfBroadcastSet.has(tf)) {
          refTfByClient.set(ws, tf);
          const payload = computeSignalsForClient(ws, tf);
          ws.send(JSON.stringify({ type: 'signals', ...payload }));
        }
        return;
      }
      if (msg.type !== 'load_history' || typeof msg.tf !== 'string') return;
      const oldest = Number(msg.oldestOpenTime);
      void handleClientLoadHistory(ws, msg.tf, oldest);
    });

    ws.on('close', () => {
      refTfByClient.delete(ws);
      watchSymbolByClient.delete(ws);
      log.info('dashboard_client_disconnected', { clients: wss.clients.size });
    });
    ws.on('error', (e) => log.warn('dashboard_client_error', { err: e.message }));
  });

  const multiplexSidecar: MultiplexCallbacks = {
    onOpen: (_route, url) => {
      log.info('dashboard_binance_feed_open', { url: url ?? '' });
      broadcast({
        type: 'status',
        connected: true,
        symbol: symbolUpper,
        watchlist: watchlistSymbols,
      });
    },
    onError: (e) => {
      log.warn('dashboard_binance_feed_error', { err: e.message });
      broadcast({ type: 'status', connected: false, error: e.message });
    },
    onReconnect: (n, reason) => {
      log.warn('dashboard_binance_feed_reconnect', { attempt: n, reason });
      broadcast({ type: 'status', reconnecting: true, attempt: n });
    },
    onServerShutdown: () => {
      log.warn('dashboard_binance_server_shutdown', {});
    },
    onKline: (sym, tf, candle, isFinal) => {
      const symU = sym.toUpperCase();
      if (!watchlistSet.has(symU)) return;
      broadcast({ type: 'kline', symbol: symU, tf, candle, isFinal });
      if (chartTfBroadcastSet.has(tf)) {
        scheduleIndicatorBroadcastForSymbol(symU, isFinal);
      }
      if (isFinal && tf === ltfTf) {
        broadcastSignalsPerClient();
        const lead = firstOpenWebSocket();
        if (lead && lead.readyState === WebSocket.OPEN) {
          const leadTf = refTfByClient.get(lead) ?? defaultChartRefTf();
          void maybeRefreshAiBrief(computeSignalsForClient(lead, leadTf), getSym(lead));
        }
      }
    },
    onMarkPrice: (u) => {
      const symU = u.symbol.toUpperCase();
      if (!watchlistSet.has(symU)) return;
      lastMarkBySym.set(symU, u.markPrice);
      broadcast({ type: 'mark_price', symbol: symU, price: u.markPrice, ts: u.eventTime });
    },
    on24hrTicker: (u) => {
      const symU = u.symbol.toUpperCase();
      if (!watchlistSet.has(symU)) return;
      broadcast({
        type: 'ticker_24hr',
        symbol: symU,
        price: u.lastPrice,
        ts: u.eventTime,
        ...(u.priceChange !== undefined ? { priceChange: u.priceChange } : {}),
        ...(u.priceChangePercent !== undefined ? { priceChangePercent: u.priceChangePercent } : {}),
        ...(u.openPrice !== undefined ? { openPrice: u.openPrice } : {}),
      });
    },
    onBookTicker: (t: BookTickerEvent) => {
      const symU = t.symbol.toUpperCase();
      if (!watchlistSet.has(symU)) return;
      lastBookBySym.set(symU, { bid: t.bestBid, ask: t.bestAsk });
      broadcast({
        type: 'book_ticker',
        symbol: symU,
        bid: t.bestBid,
        ask: t.bestAsk,
        spread: t.bestAsk - t.bestBid,
        ts: t.ts,
      });
    },
    onAggTrade: (t: AggTradeEvent) => {
      const symU = t.symbol.toUpperCase();
      if (!watchlistSet.has(symU)) return;
      broadcast({
        type: 'agg_trade',
        symbol: symU,
        price: t.price,
        qty: t.qty,
        ts: t.ts,
        makerSide: t.makerSide,
      });
    },
    onDepthDiff: (d: DepthDiff & { s: string }) => {
      const symU = d.s.toUpperCase();
      if (!watchlistSet.has(symU)) return;
      const levels = obFor(symU).topLevels(depthLevelsUi);
      broadcast({ type: 'depth', symbol: symU, bids: levels.bids, asks: levels.asks });
    },
    onDepthPartial: (p: DepthPartialEvent) => {
      const symU = (p.symbol ?? symbolUpper).toUpperCase();
      if (!watchlistSet.has(symU)) return;
      const levels = obFor(symU).topLevels(depthLevelsUi);
      broadcast({ type: 'depth', symbol: symU, bids: levels.bids, asks: levels.asks });
    },
  };

  async function listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(cfg.DASHBOARD_PORT, cfg.DASHBOARD_BIND, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });

    log.info('dashboard_listen', {
      bind: cfg.DASHBOARD_BIND,
      port: cfg.DASHBOARD_PORT,
      symbol: symbolUpper,
      watchlist: watchlistSymbols,
      chartTimeframes: chartTfsOnStream,
      ltfTf,
      uiHint:
        'Vite: npm run ui:dev or npm run dashboard:ui (bot+Vite). Open http://127.0.0.1:5173 in a normal browser; embedded previews can show chrome-error frame blocks.',
    });

    heartbeatTimer = setInterval(() => {
      broadcast({ type: 'heartbeat', ts: Date.now(), clients: wss.clients.size });
    }, 10_000);

    signalsTimer = setInterval(() => {
      broadcastSignalsPerClient();
      const lead = firstOpenWebSocket();
      if (lead && lead.readyState === WebSocket.OPEN) {
        const leadTf = refTfByClient.get(lead) ?? defaultChartRefTf();
        void maybeRefreshAiBrief(computeSignalsForClient(lead, leadTf), getSym(lead));
      }
    }, 60_000);

    const bootSignals = computeSignalsForSymbol(symbolUpper, defaultChartRefTf());
    void maybeRefreshAiBrief(bootSignals, symbolUpper);
  }

  let stopped = false;

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const t of indicatorDebounceBySym.values()) clearTimeout(t);
    indicatorDebounceBySym.clear();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (signalsTimer) {
      clearInterval(signalsTimer);
      signalsTimer = null;
    }
    for (const c of wss.clients) {
      try {
        c.terminate();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  return { multiplexSidecar, listen, stop };
}
