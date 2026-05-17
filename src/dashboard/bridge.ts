/**
 * Dashboard WebSocket bridge — consumes the same in-memory feeds as {@link HybridOrchestrator}
 * (multiplex sidecar callbacks). No second Binance WebSocket.
 */
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AppConfig } from '../config';
import { multiplexBinanceSymbols, ollamaApiUrl } from '../config';
import type { AggTradeEvent, BookTickerEvent, DepthPartialEvent, ForceOrderEvent, MultiplexCallbacks } from '../binance/ws-multiplex';
import type { MultiTimeframeStore } from '../binance/multi-tf-store';
import type { LocalOrderBook, DepthDiff } from '../binance/orderbook';
import type { AggTradeTape } from '../binance/trade-tape';
import type { PerSymbolMarketFeeds } from '../binance/per-symbol-market-feeds';
import { fetchBinanceKlines } from '../binance/rest-klines';
import { biasFromCandles } from '../strategy/htf-ltf';
import { analyzeTrend } from '../strategy/trend';
import { analyzeSmc } from '../strategy/smc';
import { analyzeKnnArchitecture, type KnnArchitectureResult } from '../strategy/knn-architecture';
import type { LiquidityEngineResult } from '../strategy/liquidity-engine';
import type { OrderBookMicroSnapshot, OrderBookSnapshotRing } from '../liquidity/order-book-snapshot-ring';
import { evaluateSolMtfStrategy } from '../strategy/sol-mtf-strategy';
import { ema, rsi, macd, supertrend } from '../strategy/indicators';
import type { Candle } from '../types';
import { requestMarketBrief, type MarketSignalsSnapshot } from '../ai/market-brief';
import {
  buildSupertrendTuneSnapshot,
  requestSupertrendTune,
} from '../ai/supertrend-tune';
import type { ClosedPosition } from '../execution/types';
import type { WalletState } from '../execution/paper/wallet';
import { defaultEventBus } from '../core/events/event-bus';
import type { AppLogger } from '../logging/app-logger';
import { ltpDisplayDecimalPlaces, type InstrumentPrecision } from '../mapping/precision';
import { assetPrecisionMapper } from '../mapping/asset-precision-mapper';
import { OiPoller } from '../signals/oi-poller';
import { FundingTracker } from '../signals/funding-tracker';
import { BinanceRestClient } from '../binance/rest-client';
import { binanceRestBase } from '../config';
import { snapshotMicrostructure } from '../binance/microstructure';
import { createScriptsApi } from './scripts-api';
import { createScriptsAi } from './scripts-ai';
import { createScriptAlertRunner } from './script-alert-runner';
import { Ollama } from 'ollama';
import type { DashboardPosition } from '../types';

const CHART_TFS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
type ChartTf = (typeof CHART_TFS)[number];

const INDICATOR_MAX_BARS = 3000;
const INDICATOR_BROADCAST_MIN_MS = 150;
const DEFAULT_SUPERTREND_PERIOD = 10;
const DEFAULT_SUPERTREND_MULT = 3;

export interface DashboardFeeds {
  store: MultiTimeframeStore;
  orderbook: LocalOrderBook;
  tradeTape: AggTradeTape;
  /** Present when `BINANCE_WATCHLIST` adds extra multiplex symbols — per-symbol book + tape. */
  marketFeeds?: PerSymbolMarketFeeds | null;
  /** Ring buffer of depth micro-snapshots (written by orchestrator on depth updates). */
  orderBookSnapshotRing?: OrderBookSnapshotRing | null;
  /**
   * Shared with {@link HybridOrchestrator}: Binance `exchangeInfo` precision per uppercase symbol.
   * The UI uses `tickSize` to pick LTP decimal places per active watch symbol (tick fractional digits only).
   */
  precisionBySymbol: Map<string, InstrumentPrecision>;
  paperWallet?: () => WalletState | null | Promise<WalletState | null>;
  paperPositions?: () => DashboardPosition[] | null | Promise<DashboardPosition[] | null>;
  livePositions?: () => DashboardPosition[] | null | Promise<DashboardPosition[] | null>;
}

export interface DashboardBridge {
  multiplexSidecar: MultiplexCallbacks;
  listen: () => Promise<void>;
  stop: () => Promise<void>;
  broadcastPaperTrade: (trade: ClosedPosition) => void;
  /** Generic broadcaster — used by event-bus bridges (trail.update, fills, closes). */
  broadcast: (msg: object) => void;
}

/** Broadcast as `type: 'signals'`; also passed to AI brief builder. */
export interface DashboardSignalsPayload {
  refPrice: number;
  refPriceTf: string;
  smcTf?: string;
  htfBias: string;
  ltfDirection: string;
  ltfConfidence: number;
  ltfScore: number;
  ltfSignals: unknown;
  smc: {
    score: number;
    liquiditySweep: string;
    /** `index` = bar offset in `refPriceTf` series (chart maps to time). */
    orderBlocks: any[];
    fvgs: any[];
    breakers: any[];
    blocks: any[];
    dealingRange: any | null;
    bos: string;
    choch: string;
    /** Swing bar → confirmation bar at `price` (for chart BOS segment). */
    bosLine: { startIndex: number; endIndex: number; price: number } | null;
    chochLine: { startIndex: number; endIndex: number; price: number } | null;
    idmLine: { startIndex: number; endIndex: number; price: number } | null;
    structPoints: any[];
    swings: any[];
    liquidity: LiquidityEngineResult | null;
    /** Top-of-book snapshot nearest the sweep candle close (or open); cleared from ring after attach. */
    liquidityOrderBook: OrderBookMicroSnapshot | null;
    /** Bar index in `refPriceTf` series for the liquidity raid candle when `liquidityOrderBook` is resolved. */
    sweepCandleIndex: number | null;
    sweepCandleOpenTime: number | null;
    signalVerdict: string;
    signalReasons: string[];
  };
  knnArchitecture: KnnArchitectureResult | null;
  solMtf: { pass: boolean; direction: string; reasons: string[] } | null;
  signalMeta: { trendSeriesTf: string; htf: string; executionLtf: string };
}

export const createDashboardBridge = (cfg: AppConfig, log: AppLogger, feeds: DashboardFeeds): DashboardBridge => {
  const {
    store,
    orderbook,
    tradeTape,
    marketFeeds = null,
    orderBookSnapshotRing = null,
    precisionBySymbol,
  } = feeds;
  const symbolUpper = cfg.BINANCE_SYMBOL.trim().toUpperCase();
  const watchlistSymbols = multiplexBinanceSymbols(cfg);
  const watchlistSet = new Set(watchlistSymbols);

  const obFor = (sym: string): LocalOrderBook => {
        return marketFeeds?.book(sym) ?? orderbook;
      }

  const tapeFor = (sym: string): AggTradeTape => {
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
  /** Sticky depth snapshot for the active sweep bar (survives ring prune after first attach). */
  const sweepOrderBookMemoBySym = new Map<string, { key: string; snap: OrderBookMicroSnapshot }>();

  const lastMarkBySym = new Map<string, number>();
  const lastBookBySym = new Map<string, { bid: number; ask: number }>();

  /** Per-symbol tracking for AI Briefs */
  const lastAiBriefAtBySym = new Map<string, number>();
  const aiBriefInflightBySym = new Set<string>();
  const latestAiBriefBySym = new Map<string, { text: string; thinking: string; ts: number; error?: string | null }>();

  let aiBriefWarnedNoModel = false;
  let aiBriefWarnedCloudKey = false;
  /** Throttle partial `ai_brief` WebSocket frames when streaming. */
  let lastAiBriefStreamBroadcastAt = 0;
  const AI_BRIEF_STREAM_MIN_MS = 75;

  /** Event detection state for AI Brief triggers */
  const lastSupertrendDirBySym = new Map<string, number>();
  const lastSmcBosBySym = new Map<string, string>();
  const lastSmcChochBySym = new Map<string, string>();

  const supertrendParamsBySym = new Map<string, { period: number; mult: number }>();
  const lastSupertrendTuneAtBySym = new Map<string, number>();
  const supertrendTuneInflight = new Set<string>();
  let stTuneWarnedNoModel = false;
  let stTuneWarnedCloudKey = false;

  const indicatorDebounceBySym = new Map<string, ReturnType<typeof setTimeout>>();

  const getSym = (client: WebSocket): string => {
    const s = watchSymbolByClient.get(client) ?? symbolUpper;
    return s.endsWith('.P') ? s.slice(0, -2) : s;
  };

  const getOpenPositions = async (): Promise<DashboardPosition[]> => {
    const paper = await feeds.paperPositions?.();
    if (Array.isArray(paper) && paper.length > 0) return paper;
    const live = await feeds.livePositions?.();
    if (Array.isArray(live)) return live;
    return [];
  };

  const scriptsApi = createScriptsApi({
    filePath: process.env.NANOPINE_SCRIPTS_PATH || 'data/nanopine-scripts.json',
    log: { info: (m, c) => log.info(m, c as never), warn: (m, c) => log.warn(m, c as never) },
  });
  const scriptsAi = createScriptsAi({ cfg });
  const scriptAlertRunner = createScriptAlertRunner({
    evaluationTf: ltfTf,
    log: { info: (m, c) => log.info(m, c as never), warn: (m, c) => log.warn(m, c as never) },
    onAlert: (event) => {
      broadcast({ type: 'script_alert', ...event });
    },
  });
  scriptAlertRunner.setScripts(scriptsApi.list()).catch((err: Error) => {
    log.warn('script_alert_initial_load_failed', { err: err.message });
  });
  scriptsApi.onChange = (scripts) => {
    scriptAlertRunner.setScripts(scripts).catch((err: Error) => {
      log.warn('script_alert_reload_failed', { err: err.message });
    });
  };

  const chatModel = (cfg.OLLAMA_MODEL || '').trim();
  const chatOllamaHost = cfg.OLLAMA_TARGET === 'cloud' ? ollamaApiUrl('cloud') : ollamaApiUrl('local');
  const chatApiKey = (cfg.OLLAMA_API_KEY || '').trim();

  const buildMarketContext = async (activeSymbol: string): Promise<string> => {
    const s = computeSignalsForSymbol(activeSymbol, defaultChartRefTf());
    const watchlistPrices: Record<string, number> = {};
    for (const sym of watchlistSymbols) {
      watchlistPrices[sym] = lastMarkBySym.get(sym) ?? 0;
    }

    const micro = snapshotMicrostructure(tapeFor(activeSymbol), obFor(activeSymbol));
    const recentTrades = tapeFor(activeSymbol).recent(10);
    const topBook = obFor(activeSymbol).topLevels(3);

    const parts: string[] = [
      `Active Symbol: ${activeSymbol}`,
      `Price: ${s.refPrice}`,
      `HTF Bias: ${s.htfBias}`,
      `LTF: direction=${s.ltfDirection}, confidence=${s.ltfConfidence}, score=${s.ltfScore}`,
    ];

    const smc = s.smc;
    parts.push(`SMC: score=${smc.score}, bos=${smc.bos}, choch=${smc.choch}, blocks=${smc.blocks?.length ?? 0}, fvgs=${smc.fvgs?.length ?? 0}, sweep=${smc.liquiditySweep}`);

    if (s.knnArchitecture) {
      const k = s.knnArchitecture;
      parts.push(`kNN: bias=${k.bias}, confidence=${k.confidence?.toFixed(2)}, stH=${k.stLines?.high}, stL=${k.stLines?.low}, ltH=${k.ltLines?.high}, ltL=${k.ltLines?.low}, deltaTanks=${k.deltaTanks?.length ?? 0}`);
    }
    if (s.solMtf) {
      parts.push(`SOL MTF: pass=${s.solMtf.pass}, direction=${s.solMtf.direction}`);
    }

    parts.push(`Watchlist Prices: ${JSON.stringify(watchlistPrices)}`);
    parts.push(`Microstructure: imbalance30s=${micro.tfi30s.tfi.toFixed(3)}, vwap30s=${(micro.tfi30s.buyVol + micro.tfi30s.sellVol).toFixed(2)}, spreadBps=${micro.spreadBps?.toFixed(1) ?? 'N/A'}, weightedObi10=${micro.weightedObi10.weightedObi.toFixed(3)}`);
    parts.push(`Order Book Top (Asks): ${topBook.asks.slice(0, 2).map(a => `${a.price}@${a.qty}`).join(', ')}`);
    parts.push(`Order Book Top (Bids): ${topBook.bids.slice(0, 2).map(b => `${b.price}@${b.qty}`).join(', ')}`);
    parts.push(`Recent Trades: ${recentTrades.slice(0, 5).map(t => `${t.makerSide ? 'S' : 'B'} ${t.price}@${t.qty}`).join(' | ')}`);

    const openPos = await getOpenPositions();
    const wallet = (await feeds.paperWallet?.()) || null;
    if (openPos.length > 0) {
      parts.push(`Open Positions: ${openPos.map(p => `${p.symbol} ${p.side} x${p.leverage} @${p.entryPrice} (pnl: ${(p.unrealizedUsdt ?? 0).toFixed(2)})`).join(', ')}`);
    } else {
      parts.push(`Open Positions: NONE`);
    }
    if (wallet) {
      parts.push(`Wallet: balance=${wallet.balanceUsdt.toFixed(2)}, available=${wallet.availableUsdt.toFixed(2)}, used=${wallet.usedMarginUsdt.toFixed(2)}`);
    }

    parts.push(`Timeframe: ${s.signalMeta?.trendSeriesTf ?? 'unknown'}, HTF: ${s.signalMeta?.htf ?? 'unknown'}`);
    return parts.join('\n');
  };

  const handleChatRequest = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!chatModel) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'OLLAMA_MODEL not configured in .env' }));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > 64 * 1024) { // Increased limit for larger context
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request too large' }));
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: { messages?: { role: string; content: string }[]; context?: boolean; symbol?: string; nanopine?: boolean };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const userMessages = Array.isArray(body.messages) ? body.messages : [];
    if (!userMessages.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No messages provided' }));
      return;
    }

    const rawSymbol = (body.symbol || symbolUpper).toUpperCase();
    const activeSymbol = rawSymbol.endsWith('.P') ? rawSymbol.slice(0, -2) : rawSymbol;
    const includeContext = body.context !== false;
    const isNanopineMode = body.nanopine === true;

    let systemMsg = `You are QuantumTrade AI, an expert crypto trading assistant.`;
    if (includeContext) {
      systemMsg += `\n\nYou have real-time market data for ${activeSymbol}:\n\n${await buildMarketContext(activeSymbol)}\n\n`;
    }

    if (isNanopineMode) {
      systemMsg += `You are in NANOPINE SCRIPT MODE. Your primary goal is to help the user write, debug, and optimize NanoPine scripts for this trading bot. 
NanoPine is a domain-specific language for strategy signals.
Syntax examples:
- "signal: LONG when close > ema(20)"
- "signal: SHORT when rsi(14) > 70 and supertrend(10, 3) == -1"
- "config: { \"riskPct\": 0.01 }"
Be precise with syntax. Do not explain things unless asked. Focus on generating valid NanoPine code snippets.`;
    } else {
      systemMsg += `Give specific, actionable trading analysis based on technical indicators, SMC structure, and order book microstructure. Be concise and professional.`;
    }

    const messages = [
      { role: 'system' as const, content: systemMsg },
      ...userMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    try {
      const headers: Record<string, string> | undefined = chatApiKey ? { Authorization: `Bearer ${chatApiKey}` } : undefined;
      const ollama = new Ollama({ host: chatOllamaHost, headers });
      const stream = await ollama.chat({ model: chatModel, messages, stream: true });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      for await (const chunk of stream) {
        if (res.destroyed) break;
        const token = chunk.message?.content ?? '';
        if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
        if (chunk.done) res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      } else {
        res.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
        res.end();
      }
    }
  };

  const httpServer = http.createServer((req, res) => {
    // CORS allows the dev UI on a different port to talk to /api directly when not proxied.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    (async () => {
      if (req.url === '/api/scripts/capabilities') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ai: scriptsAi.enabled }));
        return;
      }
      if (req.url === '/api/chat' && (req.method ?? '').toUpperCase() === 'POST') {
        await handleChatRequest(req, res);
        return;
      }
      if (await scriptsAi.handle(req, res)) return;
      if (await scriptsApi.handle(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Trading bot — dashboard WebSocket (same process as orchestrator)\n');
    })().catch((err: Error) => {
      log.warn('dashboard_http_handler_error', { err: err.message });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  const wss = new WebSocketServer({ server: httpServer });
  const historyLoadInflight = new Set<string>();

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let signalsTimer: ReturnType<typeof setInterval> | null = null;
  let validationTimer: ReturnType<typeof setInterval> | null = null;
  let oiPollTimer: ReturnType<typeof setInterval> | null = null;
  let fundingTimer: ReturnType<typeof setInterval> | null = null;
  let paperStateTimer: ReturnType<typeof setInterval> | null = null;

  const oiRestClient = new BinanceRestClient({
    apiKey: cfg.BINANCE_API_KEY ?? '',
    apiSecret: cfg.BINANCE_API_SECRET ?? '',
    baseUrl: binanceRestBase(cfg),
  });
  const oiPollers = new Map<string, OiPoller>();
  const OI_POLL_INTERVAL_SEC = 10;

  const ensureOiPoller = (sym: string): OiPoller => {
    let poller = oiPollers.get(sym);
    if (!poller) {
      poller = new OiPoller(oiRestClient, sym, OI_POLL_INTERVAL_SEC, 60);
      oiPollers.set(sym, poller);
      poller.start();
    }
    return poller;
  };

  const broadcastOiRegime = (): void => {
    for (const sym of watchlistSymbols) {
      const poller = oiPollers.get(sym);
      if (!poller) continue;
      const mark = lastMarkBySym.get(sym);
      if (Number.isFinite(mark)) poller.updatePrice(mark!);
      const snap = poller.snapshot();
      if (snap.regime === 'neutral' && snap.oi === 0) continue;
      broadcast({
        type: 'oi_regime',
        symbol: sym,
        oi: snap.oi,
        delta1m: snap.oiDelta1m,
        delta5m: snap.oiDelta5m,
        zscore: snap.oiZscore,
        divergence: snap.oiDivergence,
        spike: snap.oiSpike,
        regime: snap.regime,
      });
    }
  };

  const fundingTrackers = new Map<string, FundingTracker>();

  const ensureFundingTracker = (sym: string): FundingTracker => {
    let tracker = fundingTrackers.get(sym);
    if (!tracker) {
      tracker = new FundingTracker();
      fundingTrackers.set(sym, tracker);
    }
    return tracker;
  };

  const broadcastFunding = (): void => {
    for (const sym of watchlistSymbols) {
      const tracker = fundingTrackers.get(sym);
      if (!tracker) continue;
      const snap = tracker.snapshot();
      broadcast({
        type: 'funding',
        symbol: sym,
        rate: snap.currentRate,
        zscore: snap.zscore,
        extreme: snap.extremeFlag,
        crowdedSide: snap.crowdedSide,
      });
    }
  };

  const VALIDATION_INTERVAL_MS = 5 * 60_000;
  const VALIDATION_DEPTH = 60;

  const validateAndResyncTf = async (sym: string, tf: string): Promise<boolean> => {
    try {
      const fresh = await fetchBinanceKlines(cfg, { symbol: sym, interval: tf, limit: VALIDATION_DEPTH });
      if (!fresh.length) return false;
      const { mismatched, missing } = store.validateAgainstRest(sym, tf, fresh);
      if (mismatched.length === 0 && missing.length === 0) return false;
      log.warn('candle_store_drift', {
        symbol: sym,
        tf,
        mismatched: mismatched.length,
        missing: missing.length,
        mismatchedTimes: mismatched.slice(0, 3).map((t) => new Date(t).toISOString()),
      });
      store.reseedTail(sym, tf, fresh);
      return true;
    } catch (e) {
      log.warn('candle_validation_failed', { symbol: sym, tf, err: (e as Error).message });
      return false;
    }
  };

  const runPeriodicValidation = async (): Promise<void> => {
    let anyFixed = false;
    for (const sym of watchlistSymbols) {
      for (const tf of chartTfsOnStream) {
        if (!store.has(sym, tf)) continue;
        const fixed = await validateAndResyncTf(sym, tf);
        if (fixed) anyFixed = true;
      }
    }
    if (anyFixed) {
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        client.send(JSON.stringify({ type: 'snapshot', ...await buildSnapshot(client) }));
      }
      log.info('candle_store_resynced', { reason: 'periodic_validation' });
    }
  };

  const handleForceResync = async (ws: WebSocket): Promise<void> => {
    const sym = getSym(ws);
    log.info('force_resync_requested', { symbol: sym });
    let anyFixed = false;
    for (const tf of chartTfsOnStream) {
      try {
        const fresh = await fetchBinanceKlines(cfg, { symbol: sym, interval: tf, limit: 500 });
        if (fresh.length) {
          store.reseedTail(sym, tf, fresh);
          anyFixed = true;
        }
      } catch (e) {
        log.warn('force_resync_tf_failed', { symbol: sym, tf, err: (e as Error).message });
      }
    }
    if (anyFixed) {
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        if (getSym(client) !== sym) continue;
        client.send(JSON.stringify({ type: 'snapshot', ...await buildSnapshot(client) }));
      }
      log.info('force_resync_complete', { symbol: sym });
    }
  };

  const broadcast = (msg: object): void => {
        const raw = JSON.stringify(msg);
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(raw);
          }
        }
      }

  const getCandlesByChartTf = (sym: string): Record<ChartTf, Candle[]> => {
        const out = {} as Record<ChartTf, Candle[]>;
        for (const tf of CHART_TFS) {
          out[tf] = store.getSeries(sym, tf);
        }
        return out;
      }

  const defaultChartRefTf = (): string => {
        if (chartTfBroadcastSet.has(ltfTf)) return ltfTf;
        return chartTfsOnStream[0] ?? ltfTf;
      }

  const firstOpenWebSocket = (): WebSocket | undefined => {
        for (const c of wss.clients) {
          if (c.readyState === WebSocket.OPEN) return c;
        }
        return undefined;
      }

  const broadcastSignalsPerClient = (): void => {
        for (const client of wss.clients) {
          if (client.readyState !== WebSocket.OPEN) continue;
          const tf = refTfByClient.get(client) ?? defaultChartRefTf();
          const payload = computeSignalsForClient(client, tf);
          client.send(JSON.stringify({ type: 'signals', ...payload }));
        }
      }

  const maybeRefreshAiBrief = (signals: DashboardSignalsPayload, watchSymbol: string, force = false): void => {
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
    const last = lastAiBriefAtBySym.get(watchSymbol) ?? 0;

    if (aiBriefInflightBySym.has(watchSymbol)) return;
    // When forced by an event (flip/SMC), we still respect a minimal cooldown to prevent loop spam,
    // but the intention is that events trigger it immediately if the gap has passed.
    if (!force && last > 0 && now - last < gapMs) return;

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
      knnArchitecture: signals.knnArchitecture,
      solMtf: signals.solMtf,
    };

    aiBriefInflightBySym.add(watchSymbol);
    void requestMarketBrief(
      {
        host: ollamaApiUrl(cfg.OLLAMA_TARGET),
        model: cfg.OLLAMA_MODEL,
        apiKey: cfg.OLLAMA_API_KEY.trim() || undefined,
        timeoutMs: cfg.AI_REQUEST_TIMEOUT_MS,
        thinkEnabled: cfg.AI_BRIEF_THINK_ENABLED,
        streamEnabled: cfg.AI_BRIEF_STREAM_ENABLED,
        mcpEnabled: cfg.AI_MCP_ENABLED,
        mcpUrl: cfg.AI_MCP_URL.trim() || undefined,
        mcpMaxToolIter: cfg.AI_MCP_MAX_TOOL_ITER,
        mcpLog: log,
        onStreamChunk:
          cfg.AI_BRIEF_STREAM_ENABLED === true
            ? ({ content, thinking }) => {
                const t = Date.now();
                if (t - lastAiBriefStreamBroadcastAt < AI_BRIEF_STREAM_MIN_MS) return;
                lastAiBriefStreamBroadcastAt = t;

                // Only broadcast if this is still an active symbol for some client
                let anyClientActive = false;
                for (const client of wss.clients) {
                  if (getSym(client) === watchSymbol) {
                    anyClientActive = true;
                    break;
                  }
                }
                if (!anyClientActive) return;

                broadcast({
                  type: 'ai_brief',
                  symbol: watchSymbol,
                  text: content,
                  thinking,
                  partial: true,
                  ts: t,
                });
              }
            : undefined,
      },
      snapshot,
    ).then((r) => {
      aiBriefInflightBySym.delete(watchSymbol);
      lastAiBriefAtBySym.set(watchSymbol, Date.now());
      const ts = Date.now();

      latestAiBriefBySym.set(watchSymbol, {
        text: r.text ?? '',
        thinking: r.thinking ?? '',
        ts,
        error: r.error,
      });

      if (r.error) {
        broadcast({ type: 'ai_brief', symbol: watchSymbol, error: r.error, partial: false, ts });
        return;
      }
      broadcast({
        type: 'ai_brief',
        symbol: watchSymbol,
        text: r.text ?? '',
        thinking: r.thinking ?? '',
        partial: false,
        ts,
      });

      defaultEventBus.publish({
        id: `ai-brief-${watchSymbol}-${ts}`,
        type: 'ai.market.brief',
        ts,
        source: 'dashboard_bridge',
        symbol: watchSymbol,
        payload: {
          text: r.text ?? '',
          thinking: r.thinking ?? '',
        },
      });
    });
  }

  const sendStoredAiBrief = (client: WebSocket, symbol: string): void => {
    const stored = latestAiBriefBySym.get(symbol);
    if (stored) {
      client.send(
        JSON.stringify({
          type: 'ai_brief',
          symbol,
          text: stored.text,
          thinking: stored.thinking,
          error: stored.error,
          partial: false,
          ts: stored.ts,
        }),
      );
    }
  }

  const supertrendParamsForSymbol = (sym: string): { period: number; mult: number } => {
        return supertrendParamsBySym.get(sym) ?? {
          period: DEFAULT_SUPERTREND_PERIOD,
          mult: DEFAULT_SUPERTREND_MULT,
        };
      }

  const maybePeriodicSupertrendTune = (sym: string): void => {
        if (!cfg.AI_SUPERTREND_TUNING_ENABLED) return;
        if (!cfg.OLLAMA_MODEL.trim()) {
          if (!stTuneWarnedNoModel) {
            stTuneWarnedNoModel = true;
            log.warn('dashboard_supertrend_tune_skipped', { reason: 'OLLAMA_MODEL empty' });
          }
          return;
        }
        if (cfg.OLLAMA_TARGET === 'cloud' && !cfg.OLLAMA_API_KEY.trim()) {
          if (!stTuneWarnedCloudKey) {
            stTuneWarnedCloudKey = true;
            log.warn('dashboard_supertrend_tune_skipped', { reason: 'OLLAMA_TARGET=cloud but OLLAMA_API_KEY empty' });
          }
          return;
        }
        if (supertrendTuneInflight.has(sym)) return;
        const gapMs = cfg.AI_SUPERTREND_TUNING_INTERVAL_SEC * 1000;
        const now = Date.now();
        const last = lastSupertrendTuneAtBySym.get(sym) ?? 0;
        if (last > 0 && now - last < gapMs) return;

        const candles = store.getSeries(sym, ltfTf);
        const cur = supertrendParamsForSymbol(sym);
        const snapshot = buildSupertrendTuneSnapshot(sym, ltfTf, candles, cur.period, cur.mult);
        if (!snapshot) return;

        supertrendTuneInflight.add(sym);
        void requestSupertrendTune(
          {
            host: ollamaApiUrl(cfg.OLLAMA_TARGET),
            model: cfg.OLLAMA_MODEL,
            apiKey: cfg.OLLAMA_API_KEY.trim() || undefined,
            timeoutMs: cfg.AI_REQUEST_TIMEOUT_MS,
          },
          snapshot,
        ).then((r) => {
          supertrendTuneInflight.delete(sym);
          lastSupertrendTuneAtBySym.set(sym, Date.now());
          if (r.params) {
            supertrendParamsBySym.set(sym, { period: r.params.atrPeriod, mult: r.params.multiplier });
            log.info('dashboard_supertrend_tune_applied', {
              symbol: sym,
              atrPeriod: r.params.atrPeriod,
              multiplier: r.params.multiplier,
            });
            broadcastLatestIndicatorsForSymbol(sym);
          } else if (r.error) {
            log.warn('dashboard_supertrend_tune_failed', { symbol: sym, error: r.error });
          }
        });
      }

  const finiteSeries = (arr: number[]): (number | null)[] => {
        return arr.map((v) => (Number.isFinite(v) ? v : null));
      }

  const chartIndicatorBundle = (candles: Candle[], stPeriod: number, stMult: number) => {
        if (candles.length < 2) return null;
        const closes = candles.map((c) => c.close);
        const m = macd(closes);
        const st = supertrend(candles, stPeriod, stMult);
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

  const computeIndicatorsFromRows = (rows: Record<ChartTf, Candle[]>, sym: string): Record<string, ChartTfBundle> => {
        const st = supertrendParamsForSymbol(sym);
        const out: Record<string, ChartTfBundle> = {};
        for (const tf of CHART_TFS) {
          const series = rows[tf];
          const tail = series.length <= INDICATOR_MAX_BARS ? series : series.slice(-INDICATOR_MAX_BARS);
          const bundle = chartIndicatorBundle(tail, st.period, st.mult);
          if (bundle) out[tf] = bundle;
        }
        return out;
      }

  const broadcastLatestIndicatorsForSymbol = (sym: string): void => {
        const rows = getCandlesByChartTf(sym);
        const payload = { type: 'indicators', ...computeIndicatorsFromRows(rows, sym) };
        const raw = JSON.stringify(payload);
        for (const client of wss.clients) {
          if (client.readyState !== WebSocket.OPEN) continue;
          if (getSym(client) !== sym) continue;
          client.send(raw);
        }
      }

  const scheduleIndicatorBroadcastForSymbol = (sym: string, isFinal: boolean): void => {
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

  const refPriceFromTf = (sym: string, tf: string): number | undefined => {
        const s = store.getSeries(sym, tf);
        const c = s[s.length - 1]?.close;
        return Number.isFinite(c) ? c : undefined;
      }

  const computeSignalsForSymbol = (sym: string, requestedTf: string): DashboardSignalsPayload => {
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
        const knnArchitecture = analyzeKnnArchitecture(candlesSmc);

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

        let liquidityOrderBook: OrderBookMicroSnapshot | null = null;
        let sweepCandleIndex: number | null = null;
        let sweepCandleOpenTime: number | null = null;
        const prSweep = smc.liquidity?.primaryRejection;
        if (orderBookSnapshotRing && prSweep?.outcome === 'rejection' && prSweep.sweepBarIndex != null) {
          const bar = candlesSmc[prSweep.sweepBarIndex];
          if (bar) {
            sweepCandleIndex = prSweep.sweepBarIndex;
            sweepCandleOpenTime = bar.openTime;
            const memoKey = `${sym}:${prSweep.sweepBarIndex}:${bar.openTime}`;
            const cached = sweepOrderBookMemoBySym.get(sym);
            if (cached?.key === memoKey) {
              liquidityOrderBook = cached.snap;
            } else {
              const targetMs = bar.closeTime ?? bar.openTime;
              const matchWin = 4000;
              const snap = orderBookSnapshotRing.nearest(sym, targetMs, matchWin);
              if (snap) {
                liquidityOrderBook = snap;
                sweepOrderBookMemoBySym.set(sym, { key: memoKey, snap });
                orderBookSnapshotRing.releaseAfterSweep(sym, bar.openTime, matchWin);
              } else {
                sweepOrderBookMemoBySym.delete(sym);
              }
            }
          }
        } else {
          sweepOrderBookMemoBySym.delete(sym);
        }

        // Compute definitive SMC Execution Verdict
        let signalVerdict: 'BUY' | 'SELL' | 'NONE' = 'NONE';
        const signalReasons: string[] = [];

        // 1. Check Bullish Confluence (BUY)
        const isBullishBias = htfBiasRaw === 'LONG' || smc.choch === 'BULLISH';
        const hasSellsideSweep = smc.liquiditySweep === 'SHORT' || (smc.idmLine && smc.idmLine.endIndex === refSeries.length - 1);
        const hasBullishObMitigation = smc.orderBlocks.some(ob => ob.type === 'BULLISH' && ob.isMitigated);
        const hasBullishFvgMitigation = smc.fvgs.some(fvg => fvg.type === 'BULLISH' && fvg.isFilled);

        if (isBullishBias && (hasSellsideSweep || hasBullishObMitigation || hasBullishFvgMitigation)) {
          signalVerdict = 'BUY';
          if (htfBiasRaw === 'LONG') signalReasons.push('HTF Bullish Bias');
          if (smc.choch === 'BULLISH') signalReasons.push('Bullish CHoCH');
          if (smc.liquiditySweep === 'SHORT') signalReasons.push('Sellside Liquidity Sweep');
          if (hasBullishObMitigation) signalReasons.push('Bullish OB Mitigation');
          if (hasBullishFvgMitigation) signalReasons.push('Bullish FVG Mitigation');
        }

        // 2. Check Bearish Confluence (SELL)
        const isBearishBias = htfBiasRaw === 'SHORT' || smc.choch === 'BEARISH';
        const hasBuysideSweep = smc.liquiditySweep === 'LONG' || (smc.idmLine && smc.idmLine.endIndex === refSeries.length - 1);
        const hasBearishObMitigation = smc.orderBlocks.some(ob => ob.type === 'BEARISH' && ob.isMitigated);
        const hasBearishFvgMitigation = smc.fvgs.some(fvg => fvg.type === 'BEARISH' && fvg.isFilled);

        if (isBearishBias && (hasBuysideSweep || hasBearishObMitigation || hasBearishFvgMitigation)) {
          signalVerdict = 'SELL';
          if (htfBiasRaw === 'SHORT') signalReasons.push('HTF Bearish Bias');
          if (smc.choch === 'BEARISH') signalReasons.push('Bearish CHoCH');
          if (smc.liquiditySweep === 'LONG') signalReasons.push('Buyside Liquidity Sweep');
          if (hasBearishObMitigation) signalReasons.push('Bearish OB Mitigation');
          if (hasBearishFvgMitigation) signalReasons.push('Bearish FVG Mitigation');
        }

        return {
          refPrice,
          refPriceTf: effectiveTf,
          smcTf: refSeries.length >= SMC_MIN_BARS ? effectiveTf : ltfTf,
          htfBias: String(htfBiasRaw),
          ltfDirection: ltfTrend.direction,
          ltfConfidence: +ltfTrend.confidence.toFixed(3),
          ltfScore: ltfTrend.score,
          ltfSignals: ltfTrend.signals,
          smc: {
            score: smc.score,
            liquiditySweep: smc.liquiditySweep,
            orderBlocks: smc.orderBlocks,
            fvgs: smc.fvgs,
            breakers: smc.breakers,
            blocks: smc.blocks,
            dealingRange: smc.dealingRange,
            bos: smc.bos,
            choch: smc.choch,
            bosLine: smc.bosLine,
            chochLine: smc.chochLine,
            idmLine: smc.idmLine,
            structPoints: smc.structPoints,
            swings: smc.swings,
            liquidity: smc.liquidity,
            liquidityOrderBook,
            sweepCandleIndex,
            sweepCandleOpenTime,
            signalVerdict,
            signalReasons,
          },
          knnArchitecture,
          solMtf: solMtf ? { pass: solMtf.pass, direction: solMtf.direction, reasons: solMtf.reasons } : null,
          signalMeta: {
            trendSeriesTf: effectiveTf,
            htf: htfTf,
            executionLtf: ltfTf,
          },
        };
      }

  const computeSignalsForClient = (client: WebSocket, requestedTf: string): DashboardSignalsPayload => {
        return computeSignalsForSymbol(getSym(client), requestedTf);
      }

  const buildInstrumentPrecisionPayload = (sym: string): {
        instrumentPrecision: InstrumentPrecision | null;
        ltpDecimalPlaces: number | null;
        instrumentPrecisionBySymbol: Record<
          string,
          InstrumentPrecision & { ltpDecimalPlaces: number }
        >;
      } => {
        const instrumentPrecision = precisionBySymbol.get(sym) ?? null;
        const mark = lastMarkBySym.get(sym);
        const ltpDecimalPlaces = instrumentPrecision
          ? assetPrecisionMapper.getDecimalPlaces(
              sym,
              mark ?? 0,
              ltpDisplayDecimalPlaces(instrumentPrecision.tickSize),
            )
          : null;

        const instrumentPrecisionBySymbol: Record<string, InstrumentPrecision & { ltpDecimalPlaces: number }> =
          {};
        for (const s of watchlistSymbols) {
          const p = precisionBySymbol.get(s);
          if (p) {
            const m = lastMarkBySym.get(s);
            instrumentPrecisionBySymbol[s] = {
              ...p,
              ltpDecimalPlaces: assetPrecisionMapper.getDecimalPlaces(
                s,
                m ?? 0,
                ltpDisplayDecimalPlaces(p.tickSize),
              ),
            };
          }
        }
        return { instrumentPrecision, ltpDecimalPlaces, instrumentPrecisionBySymbol };
      }

  const buildSnapshot = async (forWs: WebSocket): Promise<Record<string, unknown>> => {
    const sym = getSym(forWs);
    const rows = getCandlesByChartTf(sym);
    const refTf = refTfByClient.get(forWs) ?? defaultChartRefTf();
    const signals = computeSignalsForClient(forWs, refTf);
    const book = lastBookBySym.get(sym);
    const mark = lastMarkBySym.get(sym);
    const precPayload = buildInstrumentPrecisionPayload(sym);
    const positions = await getOpenPositions();
    return {
      symbol: sym,
      watchlist: watchlistSymbols,
      executionSymbol: symbolUpper,
      availableTimeframes: [...chartTfsOnStream],
      mark: mark !== undefined ? mark : null,
      bestBid: book?.bid ?? null,
      bestAsk: book?.ask ?? null,
      ...precPayload,
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
      microstructure: snapshotMicrostructure(tapeFor(sym), obFor(sym)),
      indicators: computeIndicatorsFromRows(rows, sym),
      signals,
      positions,
    };
  };

  const handleClientLoadHistory = async (ws: WebSocket, tf: string, oldestOpenTime: number): Promise<void> => {
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
            ...computeIndicatorsFromRows(getCandlesByChartTf(sym), sym),
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

  wss.on('connection', async (ws, req) => {
    log.info('dashboard_client_connected', { clients: wss.clients.size });
    refTfByClient.set(ws, defaultChartRefTf());
    let initSym = symbolUpper;
    if (req?.url) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const s = u.searchParams.get('symbol');
        if (s) {
          const sUpper = s.trim().toUpperCase();
          const clean = sUpper.endsWith('.P') ? sUpper.slice(0, -2) : sUpper;
          if (watchlistSet.has(clean)) {
            initSym = clean;
          }
        }
      } catch {}
    }
    watchSymbolByClient.set(ws, initSym);
    const snap = await buildSnapshot(ws);
    ws.send(JSON.stringify({ type: 'snapshot', ...snap }));
    sendStoredAiBrief(ws, initSym);

    ws.on('message', async (raw) => {
      let msg: { type?: string; tf?: string; oldestOpenTime?: number; symbol?: string };
      try {
        msg = JSON.parse(String(raw)) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'set_watch_symbol' && typeof msg.symbol === 'string') {
        const nextRaw = msg.symbol.trim().toUpperCase();
        const next = nextRaw.endsWith('.P') ? nextRaw.slice(0, -2) : nextRaw;
        if (watchlistSet.has(next)) {
          if (watchSymbolByClient.get(ws) === next) return;
          watchSymbolByClient.set(ws, next);
          ws.send(JSON.stringify({ type: 'snapshot', ...await buildSnapshot(ws) }));
          sendStoredAiBrief(ws, next);
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
      if (msg.type === 'force_resync') {
        void handleForceResync(ws);
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

  const anomalyValidationInflight = new Set<string>();

  const validateAnomalousBar = async (sym: string, tf: string, candle: Candle): Promise<void> => {
    const key = `${sym}|${tf}|${candle.openTime}`;
    if (anomalyValidationInflight.has(key)) return;
    anomalyValidationInflight.add(key);
    try {
      const fresh = await fetchBinanceKlines(cfg, {
        symbol: sym,
        interval: tf,
        startTime: candle.openTime,
        limit: 1,
      });
      const restBar = fresh.find((c) => c.openTime === candle.openTime);
      if (!restBar) {
        log.warn('anomaly_rest_no_match', { symbol: sym, tf, openTime: candle.openTime });
        return;
      }
      const restRange = Math.abs(restBar.high - restBar.low);
      const wsRange = Math.abs(candle.high - candle.low);
      if (wsRange > restRange * 3) {
        log.warn('anomaly_rejected_confirmed', {
          symbol: sym, tf, openTime: candle.openTime,
          wsHigh: candle.high, wsLow: candle.low,
          restHigh: restBar.high, restLow: restBar.low,
        });
        store.forceApplyKline(sym, tf, restBar);
      } else {
        store.forceApplyKline(sym, tf, candle);
      }
      broadcast({ type: 'kline', symbol: sym, tf, candle: store.latest(sym, tf)!, isFinal: true });
    } catch (e) {
      log.warn('anomaly_validation_failed', { symbol: sym, tf, err: (e as Error).message });
    } finally {
      anomalyValidationInflight.delete(key);
    }
  };

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

      const latest = store.latest(symU, tf);
      const accepted = latest != null && latest.openTime === candle.openTime;

      if (!accepted) {
        void validateAnomalousBar(symU, tf, candle);
        return;
      }

      broadcast({ type: 'kline', symbol: symU, tf, candle, isFinal });
      if (chartTfBroadcastSet.has(tf)) {
        scheduleIndicatorBroadcastForSymbol(symU, isFinal);
      }
      if (isFinal) {
        void scriptAlertRunner.onClosedBar(symU, tf, candle);
      }
      if (isFinal && tf === ltfTf) {
        maybePeriodicSupertrendTune(symU);
        broadcastSignalsPerClient();

        // Detect significant events for AI Brief trigger
        const lead = firstOpenWebSocket();
        const leadSym = lead ? getSym(lead) : symbolUpper;
        const leadTf = lead ? (refTfByClient.get(lead) ?? defaultChartRefTf()) : defaultChartRefTf();
        const signals = computeSignalsForSymbol(symU, leadTf);

        let significantEvent = false;

        // 1. SuperTrend Flip detection
        const stDir = (signals.ltfSignals as any)?.supertrend?.dir;
        const lastStDir = lastSupertrendDirBySym.get(symU);
        if (stDir !== undefined && lastStDir !== undefined && stDir !== lastStDir) {
          significantEvent = true;
          log.info('ai_brief_trigger_supertrend_flip', { symbol: symU, from: lastStDir, to: stDir });
        }
        if (stDir !== undefined) lastSupertrendDirBySym.set(symU, stDir);

        // 2. SMC Structural Change detection (BOS/CHoCH)
        const bos = signals.smc.bos;
        const choch = signals.smc.choch;
        const lastBos = lastSmcBosBySym.get(symU);
        const lastChoch = lastSmcChochBySym.get(symU);

        if (bos !== 'NONE' && bos !== lastBos) {
          significantEvent = true;
          log.info('ai_brief_trigger_smc_bos', { symbol: symU, bos });
        }
        if (choch !== 'NONE' && choch !== lastChoch) {
          significantEvent = true;
          log.info('ai_brief_trigger_smc_choch', { symbol: symU, choch });
        }
        lastSmcBosBySym.set(symU, bos);
        lastSmcChochBySym.set(symU, choch);

        // Trigger AI Brief if significant event OR if this is the lead symbol (on kline close)
        if (significantEvent || symU === leadSym) {
          void maybeRefreshAiBrief(signals, symU, significantEvent);
        }
      }
    },
    onMarkPrice: (u) => {
      const symU = u.symbol.toUpperCase();
      if (!watchlistSet.has(symU)) return;
      lastMarkBySym.set(symU, u.markPrice);
      if (u.fundingRate !== 0) ensureFundingTracker(symU).update(u.fundingRate);
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
        ...(u.highPrice !== undefined ? { highPrice: u.highPrice } : {}),
        ...(u.lowPrice !== undefined ? { lowPrice: u.lowPrice } : {}),
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
      broadcast({
        type: 'microstructure',
        symbol: symU,
        ...snapshotMicrostructure(tapeFor(symU), obFor(symU)),
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
    onForceOrder: (e: ForceOrderEvent) => {
      broadcast({
        type: 'force_order',
        symbol: e.symbol,
        side: e.side,
        qty: e.filledAccumulatedQty,
        price: e.avgPrice,
        status: e.orderStatus,
        tradeTime: e.tradeTime,
      });
    },
  };

  const listen = async (): Promise<void> => {
        await new Promise<void>((resolve, reject) => {
          const errorHandler = (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
              log.warn('dashboard_bridge_port_conflict', {
                port: cfg.DASHBOARD_PORT,
                hint: `Port ${cfg.DASHBOARD_PORT} is already in use. Ensure no other instance of the bot is running (e.g., check with 'lsof -i :${cfg.DASHBOARD_PORT}').`,
              });
              reject(new Error(`Dashboard port ${cfg.DASHBOARD_PORT} in use`));
            } else {
              reject(err);
            }
          };

          httpServer.once('error', errorHandler);
          httpServer.listen(cfg.DASHBOARD_PORT, cfg.DASHBOARD_BIND, () => {
            httpServer.off('error', errorHandler);
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

        for (const sym of watchlistSymbols) ensureOiPoller(sym);

        oiPollTimer = setInterval(broadcastOiRegime, OI_POLL_INTERVAL_SEC * 1000);
        fundingTimer = setInterval(broadcastFunding, 15_000);

        heartbeatTimer = setInterval(() => {
          broadcast({ type: 'heartbeat', ts: Date.now(), clients: wss.clients.size });
        }, 10_000);

        if (feeds.paperWallet || feeds.paperPositions || feeds.livePositions) {
          paperStateTimer = setInterval(async () => {
            const wallet = await feeds.paperWallet?.();
            const mode = feeds.paperPositions ? 'paper' : 'live';
            if (wallet) {
              broadcast({ type: 'paper_wallet', mode, ...wallet });
              broadcast({ type: 'wallet', mode, ...wallet });
            }
            const positions = await getOpenPositions();
            broadcast({ type: 'position_update', mode, positions });
            if (feeds.paperPositions) {
              broadcast({ type: 'paper_position_update', positions });
            }
          }, 2000);
        }

        signalsTimer = setInterval(() => {
          for (const s of watchlistSymbols) {
            maybePeriodicSupertrendTune(s);
          }
          broadcastSignalsPerClient();
          // Periodic AI brief trigger removed in favor of event-based + kline-based triggers
        }, 60_000);

        validationTimer = setInterval(() => {
          void runPeriodicValidation();
        }, VALIDATION_INTERVAL_MS);

        const bootSignals = computeSignalsForSymbol(symbolUpper, defaultChartRefTf());
        void maybeRefreshAiBrief(bootSignals, symbolUpper);
      }

  let stopped = false;

  const stop = async (): Promise<void> => {
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
        if (validationTimer) {
          clearInterval(validationTimer);
          validationTimer = null;
        }
        if (oiPollTimer) {
          clearInterval(oiPollTimer);
          oiPollTimer = null;
        }
        if (fundingTimer) {
          clearInterval(fundingTimer);
          fundingTimer = null;
        }
        if (paperStateTimer) {
          clearInterval(paperStateTimer);
          paperStateTimer = null;
        }
        for (const p of oiPollers.values()) p.stop();
        oiPollers.clear();
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

  const broadcastPaperTrade = (trade: ClosedPosition): void => {
    broadcast({ type: 'paper_trade', ...trade });
  };

  return { multiplexSidecar, listen, stop, broadcastPaperTrade, broadcast };
}
