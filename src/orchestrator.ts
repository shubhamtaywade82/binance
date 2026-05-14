import { binanceWsBase, binanceRestBase, multiplexBinanceSymbols, isBinanceUsdmProduct, type AppConfig } from './config';
import { fetchBinanceKlines } from './binance/rest-klines';
import { fetchUsdmMarkFromRest } from './binance/rest-premium-index';
import { BinanceMarketWs, type MarkPriceUpdate, type TickerLtpUpdate } from './binance/ws-streams';
import {
  BinanceMultiplexWs,
  type AggTradeEvent,
  type BookTickerEvent,
  type DepthLevels,
  type DepthSpeed,
  type ForceOrderEvent,
  type MultiplexCallbacks,
} from './binance/ws-multiplex';
import { LiquidationCascadeTracker, type LiquidationSnapshot } from './signals/liquidation-tracker';
import { FundingTracker, type FundingSnapshot } from './signals/funding-tracker';
import { mergeMultiplexCallbacks } from './binance/merge-multiplex-callbacks';
import { MultiTimeframeStore } from './binance/multi-tf-store';
import { LocalOrderBook } from './binance/orderbook';
import { AggTradeTape } from './binance/trade-tape';
import { snapshotMicrostructure, spreadBps, type MicrostructureSnapshot } from './binance/microstructure';
import { PerSymbolMarketFeeds } from './binance/per-symbol-market-feeds';
import type { OrderBookSnapshotRing } from './liquidity/order-book-snapshot-ring';
import { fetchHistoricalKlines } from './binance/historical';
import { fetchBinanceDepthSnapshot } from './binance/rest-depth';
import {
  fetchBinanceExchangeInfoForSymbols,
} from './binance/rest-exchange-info';
import { BinancePrivateWs } from './binance/private-ws';
import {
  getPositionRisk,
  getOpenAlgoOrders,
  getOpenOrders,
  getUserTrades,
  getPositionSideDual,
  getOrderRateLimit,
  setCountdownCancelAll,
  cancelAllOrders,
  cancelAllAlgoOrders,
  getAccountInfo,
  type OrderRateLimitRow,
} from './binance/rest-trade';
import { CoinDcxFuturesClient } from './coindcx/futures-client';
import {
  extractPrecisionFromInstrument,
  type InstrumentPrecision,
} from './mapping/precision';
import { resolvePairMap, type ResolvedPairMap } from './mapping/symbol-map';
import { biasFromCandles } from './strategy/htf-ltf';
import { analyzeTrend } from './strategy/trend';
import { analyzeSmc } from './strategy/smc';
import { evaluateSmcConfluence } from './strategy/smc-confluence';
import { evaluateSolMtfStrategy, SOL_MTF_TIMEFRAMES } from './strategy/sol-mtf-strategy';
import { RiskManager } from './strategy/risk';
import { PositionManager } from './strategy/position-manager';
import { BinanceLiveExecutionAdapter } from './execution/binance-adapter';
import type { Candle, Side, TrendBias } from './types';
import { createExecutionRuntime, type ExecutionRuntime } from './execution/create-runtime';
import type { BookTickerFeed } from './execution/paper/book-ticker-feed';
import type { OrderTradeUpdate, AccountUpdate } from './binance/private-ws';
import { getRedisClient } from './services/redis';
import { publish, CHANNELS } from './services/pubsub';
import { setPosition, clearPosition, isKillSwitchActive } from './services/state';
import { ExecutionRouter } from './execution/execution-router';
import { buildFeatureVector, type FeatureSourceData } from './ai/feature-schema';
import { bookSlope, liquidityGap, tradeFlowExtended, candleDerivedFeatures } from './binance/microstructure';
import { DepthChangeTracker } from './binance/depth-change-tracker';
import { FeatureNormalizer } from './ai/feature-normalizer';
import { FeatureRecorder } from './ai/feature-recorder';
import { InferenceClient } from './ai/inference-client';
import { mlDecide } from './ai/ml-gate';
import { PredictionLogger } from './ai/prediction-logger';
import { shouldSkipEntry, type ExecutionContext } from './ai/execution-gate';
import { volatilitySizedPosition } from './ai/volatility-sizer';
import { optimalHoldTimeMs } from './ai/hold-time-optimizer';
import type { ExtendedModelOutput } from './ai/model-types';
import { StaleGuard } from './ai/stale-guard';

export interface OrchestratorLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const consoleLogger: OrchestratorLogger = {
  info: (msg, meta) => {
    process.stdout.write(`${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
  },
  warn: (msg, meta) => {
    process.stderr.write(`${msg} ${meta ? JSON.stringify(meta) : ''}\n`);
  },
};

/**
 * Returns true when current UTC time falls within TRADING_HOURS_UTC (e.g. "02:00-21:00").
 * Empty string = always allowed.
 */
const isWithinTradingHours = (spec: string): boolean => {
  if (!spec || !spec.includes('-')) return true;
  const [startStr, endStr] = spec.split('-');
  const parse = (s: string): number => {
    const [h, m] = s.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const now = new Date();
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const start = parse(startStr);
  const end = parse(endStr);
  if (start <= end) return nowMin >= start && nowMin < end;
  return nowMin >= start || nowMin < end;
};

const summarizePrivatePayload = (msg: Record<string, unknown>): Record<string, unknown> => ({
  e: msg.e,
  E: msg.E,
  T: msg.T,
  o: msg.o,
  ac: msg.ac,
});

export type UsdmMarkRestFetch = (
  cfg: AppConfig,
  symbolUpper: string,
) => Promise<{ markPrice: number; eventTime: number } | null>;

export interface OrchestratorDeps {
  cdcx?: CoinDcxFuturesClient;
  ws?: BinanceMarketWs;
  /** New multiplex feed; when provided replaces single-symbol `ws`. */
  multiplex?: BinanceMultiplexWs;
  seedKlines?: typeof fetchBinanceKlines;
  /** Historical fetcher (multi-page). Defaults to `fetchHistoricalKlines`. */
  fetchHistorical?: typeof fetchHistoricalKlines;
  /** REST depth snapshot for orderbook bootstrap. */
  fetchDepth?: typeof fetchBinanceDepthSnapshot;
  execution?: ExecutionRuntime;
  /** Override for tests; default polls Binance `premiumIndex`. */
  fetchUsdmMarkRest?: UsdmMarkRestFetch;
  /** Optional shared store; orchestrator builds one if absent. */
  store?: MultiTimeframeStore;
  /** Optional per-symbol orderbook (only when diff stream selected). */
  orderbook?: LocalOrderBook;
  /** Optional aggTrade ring buffer. */
  tradeTape?: AggTradeTape;
  /** Override for tests; default batch-fetches Binance exchangeInfo for all multiplex symbols. */
  fetchExchangeInfoForSymbols?: typeof fetchBinanceExchangeInfoForSymbols;
  /**
   * When set (dashboard mode), populated from Binance exchangeInfo for each multiplex symbol
   * so the UI can format LTP / prices per `tickSize` without a separate env per asset.
   */
  precisionBySymbol?: Map<string, InstrumentPrecision>;
  /** Merged after internal multiplex primary callbacks (e.g. dashboard WebSocket bridge). Ignored when `deps.multiplex` is set. */
  multiplexSidecar?: MultiplexCallbacks;
  /** Per-symbol depth + tape when multiplex streams multiple symbols (dashboard). */
  marketFeeds?: PerSymbolMarketFeeds;
  /** Optional ring buffer for depth snapshots (liquidity sweep attribution). */
  orderBookSnapshotRing?: OrderBookSnapshotRing | null;
}

export class HybridOrchestrator {
  private readonly pairs: ResolvedPairMap;
  private readonly c15: Candle[] = [];
  private readonly c1h: Candle[] = [];
  private readonly ws: BinanceMarketWs | null;
  private readonly multiplex: BinanceMultiplexWs | null;
  private readonly store: MultiTimeframeStore;
  private readonly orderbook: LocalOrderBook;
  private readonly tradeTape: AggTradeTape;
  private readonly liquidationTracker = new LiquidationCascadeTracker();
  private readonly fundingTracker = new FundingTracker();
  private readonly marketFeeds: PerSymbolMarketFeeds | null;
  private readonly multiplexSymbolList: string[];
  private readonly fetchHistorical: typeof fetchHistoricalKlines;
  private readonly fetchDepth: typeof fetchBinanceDepthSnapshot;
  private readonly fetchExchangeInfoForSymbols: typeof fetchBinanceExchangeInfoForSymbols;
  private readonly precisionBySymbol: Map<string, InstrumentPrecision> | null;
  private readonly ltfTf: string;
  private readonly htfTf: string;
  private readonly timeframes: string[];
  private readonly cdcx: CoinDcxFuturesClient;
  private readonly book: BookTickerFeed;
  private readonly execution: ExecutionRuntime;
  private readonly risk: RiskManager;
  private readonly positionManager: PositionManager;
  private readonly seed: typeof fetchBinanceKlines;
  private lastMark: number | null = null;
  private precision: InstrumentPrecision | null = null;
  private ltpConfirmed = false;
  private ltpWatchdog: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private restMarkTimer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchUsdmMarkRest: UsdmMarkRestFetch;
  private restMarkWarned = false;
  private readonly depthBootstrapInflight = new Set<string>();
  /** Depth micro-snapshots keyed by time for liquidity + book confluence. */
  private readonly orderBookSnapshotRing: OrderBookSnapshotRing | null;
  /** Private user-data stream — non-null when BINANCE_EXECUTION_ADAPTER=true + live. */
  private privateWs: BinancePrivateWs | null = null;
  private deadmanTimer: ReturnType<typeof setInterval> | null = null;
  private orderRateTimer: ReturnType<typeof setInterval> | null = null;
  private tradingHaltedDrawdown = false;
  private orderRatePauseActive = false;
  private drawdownHaltLogged = false;
  private sessionPeakUsdt = 0;
  /** ioredis client — null when REDIS_URL is not configured (all publish calls are no-ops). */
  private readonly redis: ReturnType<typeof getRedisClient>;

  private readonly mlNormalizer: FeatureNormalizer | null;
  private readonly mlRecorder: FeatureRecorder | null;
  private readonly mlInferenceClient: InferenceClient | null;
  private readonly mlPredictionLogger: PredictionLogger | null;
  private readonly depthChangeTracker: DepthChangeTracker | null;
  private readonly staleGuard: StaleGuard | null;

  /** Set by runMlGate when volatility model output is available. */
  private mlVolatilitySizedQty: number | null = null;
  /** Set by runMlGate when extended model output is available. */
  private mlHoldTimeMs: number | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly log: OrchestratorLogger = consoleLogger,
    deps: OrchestratorDeps = {},
  ) {
    this.pairs = resolvePairMap(cfg);
    this.cdcx = deps.cdcx ?? new CoinDcxFuturesClient({
      apiKey: cfg.COINDCX_API_KEY,
      apiSecret: cfg.COINDCX_API_SECRET,
      apiBaseUrl: cfg.API_BASE_URL,
      readOnly: cfg.READ_ONLY,
    });
    this.execution = deps.execution ?? createExecutionRuntime(cfg, this.cdcx);
    this.book = this.execution.book;
    this.risk = new RiskManager(cfg);
    this.positionManager = new PositionManager(cfg, this.execution.adapter, this.risk, this.log);
    this.seed = deps.seedKlines ?? fetchBinanceKlines;
    this.fetchUsdmMarkRest = deps.fetchUsdmMarkRest ?? fetchUsdmMarkFromRest;
    this.fetchHistorical = deps.fetchHistorical ?? fetchHistoricalKlines;
    this.fetchDepth = deps.fetchDepth ?? fetchBinanceDepthSnapshot;
    this.fetchExchangeInfoForSymbols = deps.fetchExchangeInfoForSymbols ?? fetchBinanceExchangeInfoForSymbols;
    this.precisionBySymbol = deps.precisionBySymbol ?? null;
    this.store = deps.store ?? new MultiTimeframeStore({ maxBars: 1000 });
    const tfs = (cfg.BINANCE_TIMEFRAMES && cfg.BINANCE_TIMEFRAMES.length > 0)
      ? cfg.BINANCE_TIMEFRAMES
      : [cfg.BINANCE_KLINE_INTERVAL, cfg.BINANCE_HTF_INTERVAL];
    this.timeframes = [...new Set(tfs)];
    this.ltfTf = this.timeframes[0] ?? cfg.BINANCE_KLINE_INTERVAL;
    this.htfTf = this.timeframes[1] ?? cfg.BINANCE_HTF_INTERVAL;
    if (cfg.USE_SOL_MTF_STRATEGY) {
      const subscribed = new Set(this.timeframes.map((t) => t.toLowerCase()));
      for (const req of SOL_MTF_TIMEFRAMES) {
        if (!subscribed.has(req)) {
          throw new Error(
            `USE_SOL_MTF_STRATEGY requires BINANCE_TIMEFRAMES to include ${req} (example: 5m,15m,1m,1h,4h,1d).`,
          );
        }
      }
    }
    this.tradeTape = deps.tradeTape ?? new AggTradeTape(1000);
    this.orderbook = deps.orderbook ?? new LocalOrderBook();
    this.multiplexSymbolList = multiplexBinanceSymbols(cfg);
    this.marketFeeds =
      deps.marketFeeds ??
      (this.multiplexSymbolList.length > 1
        ? new PerSymbolMarketFeeds(this.multiplexSymbolList, {
            tapeCapacity: 1000,
            primarySymbol: this.pairs.binanceSymbol,
            primaryBook: this.orderbook,
            primaryTape: this.tradeTape,
          })
        : null);
    this.orderBookSnapshotRing = deps.orderBookSnapshotRing ?? null;

    if (deps.multiplex) {
      this.multiplex = deps.multiplex;
      this.ws = null;
    } else if (deps.ws) {
      this.ws = deps.ws;
      this.multiplex = null;
    } else {
      this.ws = null;
      const primaryMx = this.bindMultiplexCallbacks();
      const multiplexCb = deps.multiplexSidecar
        ? mergeMultiplexCallbacks(primaryMx, deps.multiplexSidecar)
        : primaryMx;
      this.multiplex = new BinanceMultiplexWs(
        {
          baseWsUrl: binanceWsBase(cfg),
          symbols: this.multiplexSymbolList,
          timeframes: this.timeframes,
          product: cfg.BINANCE_PRODUCT,
          useBookTicker: cfg.BINANCE_USE_BOOKTICKER,
          useAggTrade: cfg.BINANCE_USE_AGGTRADE,
          depthLevels: cfg.BINANCE_DEPTH_LEVELS as DepthLevels,
          depthSpeed: cfg.BINANCE_DEPTH_SPEED as DepthSpeed,
          useMarkPrice: cfg.BINANCE_USE_MARK_PRICE,
          useForceOrder: cfg.BINANCE_USE_FORCE_ORDER,
          useGlobalForceOrder: cfg.BINANCE_USE_GLOBAL_FORCE_ORDER,
          reconnectAfterHours: cfg.BINANCE_WS_RECONNECT_HOURS,
        },
        multiplexCb,
      );
    }

    // Private user-data stream — live Binance adapter only.
    const needPrivateWs =
      cfg.EXECUTION_MODE === 'live' &&
      !cfg.READ_ONLY &&
      (cfg.BINANCE_EXECUTION_ADAPTER || cfg.BINANCE_PRIVATE_WS_ENABLED) &&
      this.execution.binanceRestClient;

    if (needPrivateWs && this.execution.binanceRestClient) {
      this.privateWs = new BinancePrivateWs({
        wsBase: binanceWsBase(cfg),
        client: this.execution.binanceRestClient,
        callbacks: {
          onOrderUpdate: (e) => this.onPrivateOrderUpdate(e),
          onAccountUpdate: (e) => this.onPrivateAccountUpdate(e),
          onAlgoOrderUpdate: (msg) =>
            this.log.info('binance_algo_order_update', { payload: summarizePrivatePayload(msg) }),
          onConditionalOrderTriggerReject: (msg) =>
            this.log.warn('binance_conditional_order_trigger_reject', { payload: summarizePrivatePayload(msg) }),
          onListenKeyExpired: () => this.log.warn('binance_listen_key_expired', {}),
          onError: (err) => this.log.warn('binance_private_ws_error', { err: err.message }),
          onReconnect: (n) => this.log.warn('binance_private_ws_reconnect', { attempt: n }),
          onOpen: () => this.log.info('binance_private_ws_connected', { symbol: this.pairs.binanceSymbol }),
          onClose: () => this.log.info('binance_private_ws_closed', {}),
        },
      });
    }

    this.redis = getRedisClient(cfg.REDIS_URL);

    if (cfg.ML_ENABLED) {
      this.mlNormalizer = new FeatureNormalizer();
      this.mlRecorder = new FeatureRecorder(cfg.ML_FEATURE_DIR);
      this.mlInferenceClient = new InferenceClient({
        url: cfg.ML_INFERENCE_URL,
        timeoutMs: cfg.ML_INFERENCE_TIMEOUT_MS,
      });
      this.mlPredictionLogger = new PredictionLogger(cfg.ML_PREDICTION_DIR);
      this.depthChangeTracker = new DepthChangeTracker();
      this.staleGuard = new StaleGuard();
      this.log.info('ml_pipeline_initialized', { shadow: cfg.ML_SHADOW_MODE, inferenceUrl: cfg.ML_INFERENCE_URL });
    } else {
      this.mlNormalizer = null;
      this.mlRecorder = null;
      this.mlInferenceClient = null;
      this.mlPredictionLogger = null;
      this.depthChangeTracker = null;
      this.staleGuard = null;
    }
  }

  async start(): Promise<void> {
    await this.seedCandles();
    await this.loadPrecision();

    // Push exchange precision into the Binance adapter and reconcile any open position.
    if (this.cfg.BINANCE_EXECUTION_ADAPTER && this.execution.binanceRestClient) {
      if (this.execution.router && this.precision) {
        this.execution.router.setPrecisionForBinance(this.precision);
      } else {
        const a = this.binanceLiveAdapter();
        if (a && this.precision) a.setPrecision(this.precision);
      }
      const live = this.binanceLiveAdapter();
      if (live) await this.reconcileExchangePosition(live);
    }

    this.scheduleDeadmanAndOrderRatePolling();

    if (this.multiplex) {
      this.multiplex.start();
    } else if (this.ws) {
      this.ws.start();
    }
    if (this.multiplex === null && this.cfg.BINANCE_USE_BOOKTICKER) {
      this.book.start();
    }
    if (this.privateWs) {
      await this.privateWs.start().catch((e) =>
        this.log.warn('binance_private_ws_start_failed', { err: (e as Error).message }),
      );
    }
    this.scheduleLtpWatchdog();
    this.scheduleRestMarkPoll();
    this.mlRecorder?.start();
    this.scheduleHeartbeat();
    this.log.info('orchestrator_started', {
      tradingAsset: this.cfg.TRADING_ASSET,
      binance: this.pairs.binanceSymbol,
      coindcx: this.pairs.coindcxPair,
      readOnly: this.cfg.READ_ONLY,
      placeOrder: this.cfg.PLACE_ORDER,
      executionAdapter: this.cfg.BINANCE_EXECUTION_ADAPTER ? 'binance' : 'coindcx',
      privateWs: this.privateWs !== null,
      usdmMarkRestPollSec:
        isBinanceUsdmProduct(this.cfg.BINANCE_PRODUCT) ? this.cfg.USDM_MARK_REST_POLL_SEC : 0,
      ltpCheck: 'Wait for binance_ws_connected then ltp_connected (mark, mark_rest, or ticker).',
      logFile: this.cfg.APP_LOG_PATH.trim() || '(stdout only — set APP_LOG_PATH for NDJSON file)',
    });
  }

  stop(): void {
    this.clearHeartbeat();
    this.clearRestMarkPoll();
    this.clearLtpWatchdog();
    this.clearDeadmanTimer();
    this.clearOrderRateTimer();
    this.mlRecorder?.stop();
    this.execution.stopFunding?.();
    this.book.stop();
    if (this.ws) this.ws.stop();
    if (this.multiplex) void this.multiplex.stop();
    if (this.privateWs) void this.privateWs.stop();
  }

  /** Expose private WS for lifecycle registration. */
  getPrivateWs(): BinancePrivateWs | null {
    return this.privateWs;
  }

  /** Non-null when the orchestrator owns or was given a multiplex connection. */
  getMultiplexWs(): BinanceMultiplexWs | null {
    return this.multiplex;
  }

  /** Wire callbacks into a caller-provided multiplex; useful for index.ts wiring. */
  bindMultiplexCallbacks(): MultiplexCallbacks {
    return {
      onKline: (sym, tf, c, fin) => this.onMultiplexKline(sym, tf, c, fin),
      onBookTicker: (t) => this.onBookTicker(t),
      onAggTrade: (t) => this.onAggTradeEvent(t),
      onMarkPrice: (u) => {
        this.onMark({ symbol: u.symbol, markPrice: u.markPrice, eventTime: u.eventTime });
        if (u.fundingRate !== 0) this.fundingTracker.update(u.fundingRate);
      },
      on24hrTicker: (u) => this.onTickerLtp({ symbol: u.symbol, lastPrice: u.lastPrice, eventTime: u.eventTime }),
      onDepthDiff: (d) => this.onDepthDiffEvent(d),
      onDepthPartial: (p) => this.onDepthPartialEvent(p),
      onForceOrder: (e) => this.onForceOrderEvent(e),
      onServerShutdown: () => this.log.warn('binance_ws_server_shutdown', {}),
      onOpen: (route, url) => this.onWsOpen(route, url),
      onError: (e) => this.log.warn('binance_ws_error', { err: e.message }),
      onReconnect: (n, reason) => this.onWsReconnectMx(n, reason),
    };
  }

  private obFor(sym: string): LocalOrderBook {
    return this.marketFeeds?.book(sym) ?? this.orderbook;
  }

  private tapeFor(sym: string): AggTradeTape {
    return this.marketFeeds?.tape(sym) ?? this.tradeTape;
  }

  private onWsReconnectMx(attempt: number, reason: string): void {
    this.log.warn('binance_ws_reconnect', { attempt, reason });
    this.ltpConfirmed = false;
    this.scheduleLtpWatchdog();
  }

  private onMultiplexKline(symbol: string, tf: string, candle: Candle, isFinal: boolean): void {
    const symU = symbol.toUpperCase();
    if (!this.multiplexSymbolList.includes(symU)) return;
    const accepted = this.store.applyKline(symbol, tf, candle, isFinal);
    if (symU !== this.pairs.binanceSymbol.toUpperCase()) return;
    if (tf === this.ltfTf) {
      const series = this.store.getSeries(symbol, this.ltfTf);
      this.c15.splice(0, this.c15.length, ...series);
    } else if (tf === this.htfTf) {
      const series = this.store.getSeries(symbol, this.htfTf);
      this.c1h.splice(0, this.c1h.length, ...series);
    }
    if (accepted && isFinal && tf === this.ltfTf) void this.evaluate(candle);
  }

  private onBookTicker(t: BookTickerEvent): void {
    const symU = t.symbol.toUpperCase();
    if (!this.multiplexSymbolList.includes(symU)) return;
    if (symU !== this.pairs.binanceSymbol.toUpperCase()) return;
    const tick = {
      symbol: symU,
      bestBid: t.bestBid,
      bestAsk: t.bestAsk,
      spread: t.bestAsk - t.bestBid,
      ts: t.ts,
    };
    this.book.ingest(tick);
  }

  private onAggTradeEvent(t: AggTradeEvent): void {
    const symU = t.symbol.toUpperCase();
    if (!this.multiplexSymbolList.includes(symU)) return;
    this.tapeFor(symU).push({ price: t.price, qty: t.qty, ts: t.ts, makerSide: t.makerSide });
    if (symU !== this.pairs.binanceSymbol.toUpperCase()) return;
    this.book.ingestTrade(symU, t.price);
    this.staleGuard?.markFresh('trade');
  }

  private onDepthDiffEvent(d: import('./binance/orderbook').DepthDiff & { s: string }): void {
    const symU = d.s.toUpperCase();
    if (!this.multiplexSymbolList.includes(symU)) return;
    if (symU === this.pairs.binanceSymbol.toUpperCase()) this.staleGuard?.markFresh('depth');
    if (this.cfg.BINANCE_DEPTH_LEVELS > 0) return;
    const ob = this.obFor(symU);
    if (!ob.isBootstrapped()) {
      ob.buffer(d);
      if (!this.depthBootstrapInflight.has(symU)) {
        this.depthBootstrapInflight.add(symU);
        void this.finishDepthBootstrapForSymbol(symU, ob);
      }
      return;
    }
    ob.applyDiff(d);
    this.recordDepthSnapshot(symU);
  }

  private recordDepthSnapshot(symU: string): void {
    if (!this.orderBookSnapshotRing) return;
    const ob = this.obFor(symU);
    this.orderBookSnapshotRing.recordFromBook(symU, ob);
  }

  private onDepthPartialEvent(p: import('./binance/ws-multiplex').DepthPartialEvent): void {
    const symU = (p.symbol ?? this.pairs.binanceSymbol).toUpperCase();
    if (!this.multiplexSymbolList.includes(symU)) return;
    if (symU === this.pairs.binanceSymbol.toUpperCase()) this.staleGuard?.markFresh('depth');
    this.obFor(symU).replaceFromPartial({ bids: p.bids, asks: p.asks });
    this.recordDepthSnapshot(symU);
  }

  /** After buffering diff events, align REST snapshot then replay (Binance depth procedure). */
  private async finishDepthBootstrapForSymbol(symU: string, ob: LocalOrderBook): Promise<void> {
    try {
      if (ob.isBootstrapped()) return;
      const snap = await this.fetchDepth(this.cfg, symU, 1000);
      if (snap) {
        ob.bootstrap(snap);
        this.log.info('orderbook_bootstrapped', { symbol: symU, lastUpdateId: snap.lastUpdateId });
      } else {
        this.log.warn('orderbook_bootstrap_empty', { symbol: symU });
      }
    } catch (e) {
      this.log.warn('orderbook_bootstrap_failed', { symbol: symU, err: (e as Error).message });
    } finally {
      this.depthBootstrapInflight.delete(symU);
    }
  }

  /** Multiplex helpers exposed for index.ts/tests. */
  getMultiTimeframeStore(): MultiTimeframeStore {
    return this.store;
  }
  getOrderbook(): LocalOrderBook {
    return this.orderbook;
  }
  getTradeTape(): AggTradeTape {
    return this.tradeTape;
  }

  /** Latest microstructure features (TFI, weighted OBI, microprice) for the primary symbol. */
  getMicrostructure(): MicrostructureSnapshot {
    return snapshotMicrostructure(this.tradeTape, this.orderbook);
  }

  getLiquidationSnapshot(): LiquidationSnapshot {
    return this.liquidationTracker.snapshot();
  }

  getFundingSnapshot(): FundingSnapshot {
    return this.fundingTracker.snapshot();
  }

  private onForceOrderEvent(e: ForceOrderEvent): void {
    this.liquidationTracker.push(e);
  }

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    const sec = this.cfg.LOG_HEARTBEAT_SEC;
    if (sec <= 0) return;
    this.heartbeatTimer = setInterval(() => this.logHeartbeat(), sec * 1000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private logHeartbeat(): void {
    const htfBias = this.reversalTrendBias();
    const ltfBias = biasFromCandles(this.c15);
    const micro = this.getMicrostructure();
    this.log.info('heartbeat', {
      binanceMark: this.lastMark,
      ltpConfirmed: this.ltpConfirmed,
      htfBias,
      ltfBias,
      execTf: this.ltfTf,
      barsExec: this.c15.length,
      barsHTF: this.c1h.length,
      inPosition: this.positionManager.hasPosition(),
      tfi1s: +micro.tfi1s.tfi.toFixed(4),
      weightedObi5: +micro.weightedObi5.weightedObi.toFixed(4),
      microprice: micro.microprice != null ? +micro.microprice.toFixed(4) : null,
    });

    if (this.mlRecorder && this.mlNormalizer) {
      if (this.staleGuard?.anyStale()) {
        this.log.info('ml_feature_skipped_stale', { staleSources: this.staleGuard.staleSources() });
      } else {
        const fv = this.buildMlFeatureVector();
        if (fv) {
          const normalized = this.mlNormalizer.normalize(fv);
          this.mlRecorder.record(normalized);
        }
      }
    }
  }

  private buildMlFeatureVector() {
    const sym = this.pairs.binanceSymbol;
    const micro = this.getMicrostructure();
    const funding = this.fundingTracker.snapshot();
    const liquidation = this.liquidationTracker.snapshot();
    const ofi = this.orderbook.isBootstrapped() ? 0 : 0;

    const oiSnap: import('./signals/oi-poller').OiSnapshot = { oi: 0, oiDelta1m: 0, oiDelta5m: 0, oiZscore: 0, oiDivergence: 0, oiSpike: 0, regime: 'neutral' };

    this.depthChangeTracker?.update(this.orderbook);

    const candle1m = this.store.getSeries(sym, '1m').at(-1);
    const candle5m = this.store.getSeries(sym, '5m').at(-1);
    const series1m = this.store.getSeries(sym, '1m');
    const series5m = this.store.getSeries(sym, '5m');

    const src: FeatureSourceData = {
      micro, funding, oi: oiSnap, liquidation,
      ofiCumulative: ofi,
      bookSlope: bookSlope(this.orderbook, 10),
      liquidityGap: liquidityGap(this.orderbook, 20),
      tradeFlowExt: tradeFlowExtended(this.tapeFor(sym), 5),
      candleFeatures1m: candleDerivedFeatures(series1m, 20),
      candleFeatures5m: candleDerivedFeatures(series5m, 20),
      depthChange: this.depthChangeTracker?.snapshot() ?? { cancelIntensity: 0, bookThinning: 0, bidWallPersistence: 0, askWallPersistence: 0 },
      markPrice: micro.mid ?? 0,
      lastTradePrice: this.tapeFor(sym).lastPrice() ?? 0,
      candle1m, candle5m, symbol: sym,
    };
    return buildFeatureVector(src);
  }

  /** Daily bias when SOL MTF strategy is on; else HTF EMA bias from the secondary candle buffer. */
  private reversalTrendBias(): TrendBias {
    if (this.cfg.USE_SOL_MTF_STRATEGY) {
      return biasFromCandles(this.store.getSeries(this.pairs.binanceSymbol, '1d'));
    }
    return biasFromCandles(this.c1h);
  }

  private onWsOpen(route?: string, url?: string): void {
    this.log.info('binance_ws_connected', {
      wsBase: binanceWsBase(this.cfg),
      route,
      url,
      product: this.cfg.BINANCE_PRODUCT,
      symbol: this.pairs.binanceSymbol,
      ltf: this.cfg.BINANCE_KLINE_INTERVAL,
    });
  }

  private scheduleLtpWatchdog(): void {
    this.clearLtpWatchdog();
    const sec = this.cfg.LTP_CONNECT_WARN_SEC;
    if (sec <= 0) return;
    this.ltpWatchdog = setTimeout(() => {
      this.ltpWatchdog = null;
      if (this.ltpConfirmed) return;
      this.log.warn('ltp_connect_timeout', {
        waitedSec: sec,
        symbol: this.pairs.binanceSymbol,
        usdmMarkRestPollSec: this.cfg.USDM_MARK_REST_POLL_SEC,
        hint:
          isBinanceUsdmProduct(this.cfg.BINANCE_PRODUCT)
            ? this.cfg.USDM_MARK_REST_POLL_SEC > 0
              ? 'No mark on WS yet; if fapi REST is blocked too, mark REST poll will also fail. Else expect ltp_connected (mark_rest) on next poll.'
              : 'No markPriceUpdate yet — enable USDM_MARK_REST_POLL_SEC (default 5) or check BINANCE_WS_BASE / network.'
            : 'No 24hrTicker yet — check network, symbol, or BINANCE_WS_BASE.',
      });
    }, sec * 1000);
  }

  private clearLtpWatchdog(): void {
    if (this.ltpWatchdog) {
      clearTimeout(this.ltpWatchdog);
      this.ltpWatchdog = null;
    }
  }

  private confirmLtp(source: 'mark' | 'mark_rest' | 'ticker', price: number, eventTime: number): void {
    if (this.ltpConfirmed) return;
    if (!Number.isFinite(price)) return;
    this.ltpConfirmed = true;
    this.clearLtpWatchdog();
    const note =
      source === 'mark'
        ? 'USD-M mark from WebSocket'
        : source === 'mark_rest'
          ? 'USD-M mark from GET /fapi/v1/premiumIndex (WS silent or slow)'
          : 'Spot last price from ticker';
    this.log.info('ltp_connected', {
      source,
      price,
      eventTime,
      symbol: this.pairs.binanceSymbol,
      note,
    });
  }

  injectCandles(ltf: Candle[], htf: Candle[]): void {
    const sym = this.pairs.binanceSymbol;
    this.store.seed(sym, this.ltfTf, ltf);
    this.store.seed(sym, this.htfTf, htf);
    this.refreshLegacyBuffers();
  }

  /** Seed any intervals (e.g. SOL MTF harness). Keys must match Binance interval strings (`5m`, `1d`, …). */
  injectMultiTimeframeSeries(series: Partial<Record<string, Candle[]>>): void {
    const sym = this.pairs.binanceSymbol;
    for (const [tf, candles] of Object.entries(series)) {
      if (candles?.length) this.store.seed(sym, tf.toLowerCase(), candles);
    }
    this.refreshLegacyBuffers();
  }

  private refreshLegacyBuffers(): void {
    const sym = this.pairs.binanceSymbol;
    this.c15.splice(0, this.c15.length, ...this.store.getSeries(sym, this.ltfTf));
    this.c1h.splice(0, this.c1h.length, ...this.store.getSeries(sym, this.htfTf));
  }

  hasPosition(): boolean {
    return this.positionManager.hasPosition();
  }

  /** Returns the ExecutionRouter wrapping the current adapter, or null when the execution
   *  runtime was injected without a router (e.g. in unit tests with a raw adapter). */
  getRouter(): ExecutionRouter | null {
    return this.execution.router ?? null;
  }

  setPrecision(p: InstrumentPrecision): void {
    this.precision = p;
    this.publishPrecisionToHub(this.pairs.binanceSymbol.toUpperCase(), p);
  }

  private publishPrecisionToHub(symUpper: string, p: InstrumentPrecision): void {
    if (!this.precisionBySymbol) return;
    this.precisionBySymbol.set(symUpper, p);
  }

  async evaluateBar(bar: Candle): Promise<void> {
    return this.evaluate(bar);
  }

  private async seedCandles(): Promise<void> {
    if (this.multiplex) {
      const limit = this.cfg.BINANCE_HISTORY_BARS ?? 500;
      for (const sym of this.multiplexSymbolList) {
        for (const tf of this.timeframes) {
          try {
            const bars = await this.seed(this.cfg, { symbol: sym, interval: tf, limit });
            this.store.seed(sym, tf, bars);
          } catch (e) {
            this.log.warn('candles_seed_failed', { symbol: sym, tf, err: (e as Error).message });
          }
        }
      }
      const sym = this.pairs.binanceSymbol;
      const ltfBars = this.store.getSeries(sym, this.ltfTf);
      const htfBars = this.store.getSeries(sym, this.htfTf);
      this.c15.splice(0, this.c15.length, ...ltfBars);
      this.c1h.splice(0, this.c1h.length, ...htfBars);
      this.log.info('candles_seeded', {
        timeframes: this.timeframes,
        ltf: this.ltfTf,
        htf: this.htfTf,
        nLtf: this.c15.length,
        nHtf: this.c1h.length,
      });
      return;
    }
    const [h15, h1h] = await Promise.all([
      this.seed(this.cfg, {
        symbol: this.pairs.binanceSymbol,
        interval: this.cfg.BINANCE_KLINE_INTERVAL,
        limit: 200,
      }),
      this.seed(this.cfg, {
        symbol: this.pairs.binanceSymbol,
        interval: this.cfg.BINANCE_HTF_INTERVAL,
        limit: 120,
      }),
    ]);
    this.c15.splice(0, this.c15.length, ...h15);
    this.c1h.splice(0, this.c1h.length, ...h1h);
    this.log.info('candles_seeded', { n15: this.c15.length, n1h: this.c1h.length });
  }

  /** Optional: paginated historical seed for one tf. */
  async seedHistorical(tf: string, startMs: number, endMs: number, maxBars?: number): Promise<void> {
    const sym = this.pairs.binanceSymbol;
    const bars = await this.fetchHistorical(this.cfg, { symbol: sym, interval: tf, startMs, endMs, maxBars });
    this.store.seed(sym, tf, bars);
  }

  private async loadPrecision(): Promise<void> {
    const hubSymbols = this.multiplexSymbolList.map((s) => s.toUpperCase());
    const primaryU = this.pairs.binanceSymbol.toUpperCase();

    if (isBinanceUsdmProduct(this.cfg.BINANCE_PRODUCT)) {
      try {
        const map = await this.fetchExchangeInfoForSymbols(binanceRestBase(this.cfg), hubSymbols);
        for (const symU of hubSymbols) {
          const row = map.get(symU);
          if (row) this.publishPrecisionToHub(symU, row);
        }
        const primaryPrec = map.get(primaryU);
        if (primaryPrec) {
          this.precision = primaryPrec;
          const missing = hubSymbols.filter((s) => !map.has(s));
          this.log.info('instrument_precision', {
            source: 'binance_exchange_info',
            symbols: hubSymbols,
            resolved: [...map.keys()].filter((k) => hubSymbols.includes(k)),
            missing: missing.length ? missing : undefined,
            tickSize: this.precision.tickSize,
            stepSize: this.precision.stepSize,
            minQty: this.precision.minQty,
          });
          return;
        }
      } catch (e) {
        this.log.warn('binance_exchange_info_failed', { err: (e as Error).message });
      }
    }

    try {
      const raw = await this.cdcx.getFuturesInstrumentDetails(this.pairs.coindcxPair);
      this.precision = extractPrecisionFromInstrument(raw);
      this.publishPrecisionToHub(primaryU, this.precision);
      this.log.info('instrument_precision', {
        source: 'coindcx',
        ...this.precision as unknown as Record<string, unknown>,
      });
    } catch (e) {
      this.log.warn('instrument_precision_failed', { err: (e as Error).message });
      this.precision = extractPrecisionFromInstrument(null);
      this.publishPrecisionToHub(primaryU, this.precision);
    }
  }

  private onMark(u: MarkPriceUpdate): void {
    if (u.symbol.toUpperCase() !== this.pairs.binanceSymbol) return;
    this.applyMarkReference(u.markPrice, u.eventTime, 'mark');
  }

  private onTickerLtp(u: TickerLtpUpdate): void {
    if (u.symbol.toUpperCase() !== this.pairs.binanceSymbol) return;
    this.applyMarkReference(u.lastPrice, u.eventTime, 'ticker');
  }

  private applyMarkReference(
    price: number,
    eventTime: number,
    ltpSource: 'mark' | 'mark_rest' | 'ticker',
  ): void {
    if (!Number.isFinite(price)) return;
    this.lastMark = price;
    this.staleGuard?.markFresh('markPrice');
    if (ltpSource === 'ticker') this.confirmLtp('ticker', price, eventTime);
    else this.confirmLtp(ltpSource, price, eventTime);
    const symU = this.pairs.binanceSymbol.toUpperCase();
    const liveBook =
      this.cfg.BINANCE_USE_BOOKTICKER && this.multiplex !== null && this.book.latest(symU);
    if (!liveBook) this.feedSyntheticBook(price);
    const sym = this.pairs.binanceSymbol.toUpperCase();
    this.execution.adapter.onMark?.(sym, price);
    publish(this.redis, CHANNELS.TICKS, { symbol: sym, price, ts: Date.now() });
    this.positionManager.onMark(price, this.reversalTrendBias()).then((closeEvent) => {
      if (!closeEvent) return;
      clearPosition(this.redis, sym);
      publish(this.redis, CHANNELS.POSITIONS, {
        event: 'close',
        symbol: sym,
        side: closeEvent.position.side,
        entryPrice: closeEvent.position.entryPrice,
        exitPrice: closeEvent.exitPrice,
        reason: closeEvent.reason,
        netUsdt: closeEvent.pnl.netUsdt,
        ts: Date.now(),
      });
    }).catch(() => undefined);
  }

  private scheduleRestMarkPoll(): void {
    this.clearRestMarkPoll();
    if (!isBinanceUsdmProduct(this.cfg.BINANCE_PRODUCT)) return;
    const sec = this.cfg.USDM_MARK_REST_POLL_SEC;
    if (sec <= 0) return;
    void this.pollRestMarkOnce();
    this.restMarkTimer = setInterval(() => void this.pollRestMarkOnce(), sec * 1000);
  }

  private clearRestMarkPoll(): void {
    if (this.restMarkTimer) {
      clearInterval(this.restMarkTimer);
      this.restMarkTimer = null;
    }
  }

  private async pollRestMarkOnce(): Promise<void> {
    if (!isBinanceUsdmProduct(this.cfg.BINANCE_PRODUCT)) return;
    try {
      const row = await this.fetchUsdmMarkRest(this.cfg, this.pairs.binanceSymbol);
      if (!row) {
        if (!this.restMarkWarned) {
          this.restMarkWarned = true;
          this.log.warn('usdm_mark_rest_empty', { symbol: this.pairs.binanceSymbol });
        }
        return;
      }
      this.restMarkWarned = false;
      this.applyMarkReference(row.markPrice, row.eventTime, 'mark_rest');
    } catch (e) {
      if (!this.restMarkWarned) {
        this.restMarkWarned = true;
        this.log.warn('usdm_mark_rest_failed', {
          symbol: this.pairs.binanceSymbol,
          err: (e as Error).message,
        });
      }
    }
  }

  /** Paper fills use `BookTickerFeed`; without a second WS we mirror mid from mark/ticker. */
  private feedSyntheticBook(mid: number): void {
    const sym = this.pairs.binanceSymbol.toUpperCase();
    const half = Math.max(mid * 0.00005, 0.0001);
    this.book.ingest({
      symbol: sym,
      bestBid: mid - half,
      bestAsk: mid + half,
      spread: half * 2,
      ts: Date.now(),
    });
    this.book.ingestTrade(sym, mid);
  }

  private onPrivateOrderUpdate(event: OrderTradeUpdate): void {
    const o = event.order;
    this.log.info('binance_order_update', {
      symbol: o.s,
      orderId: o.i,
      strategyId: o.si,
      status: o.X,
      execType: o.x,
      side: o.S,
      type: o.o,
      avgPrice: o.ap,
      filledQty: o.z,
      realizedPnl: o.rp,
    });

    // Reconcile exchange-triggered algo TP/SL fills.
    // algo orders include a strategyId (si) — regular orders do not.
    if (
      o.X === 'FILLED' &&
      o.x === 'TRADE' &&
      typeof o.si === 'number' &&
      o.si > 0 &&
      this.cfg.BINANCE_EXECUTION_ADAPTER
    ) {
      const binanceAdapter = this.binanceLiveAdapter();
      if (!binanceAdapter) return;
      const fillPrice = Number(o.ap) || Number(o.L) || this.lastMark || 0;
      if (fillPrice > 0) {
        const result = binanceAdapter.notifyFilled(o.si, fillPrice);
        if (result?.fullyFilled) {
          const sym = this.pairs.binanceSymbol.toUpperCase();
          clearPosition(this.redis, sym);
          publish(this.redis, CHANNELS.POSITIONS, {
            event: 'close',
            symbol: sym,
            exitPrice: result.closed.exitPrice,
            reason: result.closed.reason,
            source: 'exchange_algo',
            ts: Date.now(),
          });
          void this.positionManager.notifyExchangeClose(result.closed.exitPrice, result.closed.reason);
        }
      }
    }
  }

  /** Fetch open positions and algo orders from Binance on startup; restore state if found. */
  private async reconcileExchangePosition(adapter: BinanceLiveExecutionAdapter): Promise<void> {
    if (!this.execution.binanceRestClient) return;
    const client = this.execution.binanceRestClient;
    const sym = this.pairs.binanceSymbol;
    try {
      const [positions, algoOrders, dual, openOrders, userTrades, rateRows, account] = await Promise.all([
        getPositionRisk(client, sym),
        getOpenAlgoOrders(client, sym),
        getPositionSideDual(client),
        getOpenOrders(client, sym),
        getUserTrades(client, { symbol: sym, limit: 20 }).catch(() => []),
        getOrderRateLimit(client),
        getAccountInfo(client),
      ]);

      this.execution.router?.applyBinanceHedgeMode(dual.dualSidePosition);
      if (dual.dualSidePosition) {
        this.log.warn('binance_hedge_mode_active', { sym, hint: 'Orders include positionSide LONG/SHORT.' });
      } else {
        this.log.info('binance_one_way_mode', { sym });
      }

      const tw = Number(account.totalWalletBalance);
      if (Number.isFinite(tw) && tw > 0) {
        this.sessionPeakUsdt = Math.max(this.sessionPeakUsdt, tw);
      }

      this.log.info('startup_reconcile_orders', {
        sym,
        openOrders: openOrders.length,
        openAlgo: algoOrders.length,
        recentUserTrades: userTrades.length,
      });
      if (openOrders.length > algoOrders.length + 2) {
        this.log.warn('startup_extra_open_orders', { openOrders: openOrders.length, sym });
      }
      this.applyOrderRateRows(rateRows);

      const pos = positions.find(
        (p) => p.symbol.toUpperCase() === sym && Math.abs(Number(p.positionAmt)) > 0,
      );
      if (!pos) {
        this.log.info('startup_no_open_position', { sym });
        return;
      }

      const internalId = adapter.restoreFromExchange(pos, algoOrders);
      if (!internalId) return;

      const side: Side = Number(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
      const entryPrice = Number(pos.entryPrice);
      const qty = Math.abs(Number(pos.positionAmt));
      const { takeProfit, stopLoss } = this.risk.targets(entryPrice, side);

      this.positionManager.restoreFromExchange({
        side,
        entryPrice,
        quantity: qty,
        pair: this.pairs.coindcxPair,
        orderId: internalId,
        takeProfit,
        stopLoss,
        openedAt: pos.updateTime || Date.now(),
        notionalUsdt: entryPrice * qty,
      });
    } catch (e) {
      this.log.warn('startup_reconcile_failed', { err: (e as Error).message });
    }
  }

  private onPrivateAccountUpdate(event: AccountUpdate): void {
    const balances = event.a?.B ?? [];
    const usdt = balances.find((b) => b.a === 'USDT');
    if (usdt) {
      const wb = Number(usdt.wb);
      if (Number.isFinite(wb) && wb > 0) {
        if (this.sessionPeakUsdt <= 0) this.sessionPeakUsdt = wb;
        else this.sessionPeakUsdt = Math.max(this.sessionPeakUsdt, wb);
        const pct = this.cfg.DAILY_DRAWDOWN_KILL_PCT;
        if (pct > 0 && this.sessionPeakUsdt > 0 && wb <= this.sessionPeakUsdt * (1 - pct)) {
          void this.handleDrawdownKill(wb);
        }
      }
    }

    const positions = event.a?.P ?? [];
    for (const p of positions) {
      if (p.s.toUpperCase() !== this.pairs.binanceSymbol) continue;
      this.log.info('binance_account_update', {
        symbol: p.s,
        positionAmt: p.pa,
        entryPrice: p.ep,
        unrealizedPnl: p.up,
        marginType: p.mt,
      });
    }
  }

  private async evaluate(ltfBar: Candle): Promise<void> {
    if (this.positionManager.hasPosition()) return;
    if (this.tradingHaltedDrawdown || this.orderRatePauseActive) return;

    if (!isWithinTradingHours(this.cfg.TRADING_HOURS_UTC)) return;

    const maxPos = this.cfg.MAX_OPEN_POSITIONS;
    if (maxPos > 0 && this.positionManager.openCount() >= maxPos) return;

    const maxSpread = this.cfg.MAX_ENTRY_SPREAD_BPS;
    if (maxSpread > 0) {
      const currentSpread = spreadBps(this.orderbook);
      if (currentSpread !== null && currentSpread > maxSpread) {
        this.log.info('spread_guard_reject', { spreadBps: +currentSpread.toFixed(2), maxBps: maxSpread });
        return;
      }
    }

    const refPrice = this.lastMark ?? ltfBar.close;
    const sym = this.pairs.binanceSymbol;

    if (this.cfg.USE_SOL_MTF_STRATEGY) {
      const sol = evaluateSolMtfStrategy({
        candles: {
          '1d': this.store.getSeries(sym, '1d'),
          '4h': this.store.getSeries(sym, '4h'),
          '1h': this.store.getSeries(sym, '1h'),
          '15m': this.store.getSeries(sym, '15m'),
          '5m': this.store.getSeries(sym, '5m'),
        },
        refPrice,
        minConfidence: this.cfg.MIN_CONFIDENCE,
      });

      this.log.info('sol_mtf_strategy', {
        pass: sol.pass,
        direction: sol.direction,
        reasons: sol.reasons,
      });

      if (!sol.pass) return;

      const confluence = evaluateSmcConfluence(
        this.store.getSeries(sym, '5m'),
        this.store.getSeries(sym, '1h'),
        sol.direction,
        refPrice,
        {
          enabled: this.cfg.USE_SMC_CONFLUENCE,
          mode: this.cfg.SMC_CONFLUENCE_MODE,
          standardMinScore: this.cfg.SMC_CONFLUENCE_MIN_STANDARD,
          sniperMinScore: this.cfg.SMC_CONFLUENCE_MIN_SNIPER,
          targetPct: this.cfg.SMC_CONFLUENCE_TARGET_PCT,
        },
      );

      this.log.info('smc_confluence', {
        enabled: this.cfg.USE_SMC_CONFLUENCE,
        pass: confluence.pass,
        score: Number(confluence.score.toFixed(2)),
        threshold: confluence.threshold,
        reasons: confluence.reasons,
      });

      if (this.cfg.USE_SMC_CONFLUENCE && !confluence.pass) return;

      const smcSide: Side = sol.direction === 'LONG' ? 'LONG' : 'SHORT';
      const mlResult = await this.runMlGate(smcSide, sym, refPrice);
      if (mlResult === 'blocked') return;

      if (await isKillSwitchActive(this.redis)) {
        this.log.warn('kill_switch_active', { symbol: sym });
        return;
      }
      publish(this.redis, CHANNELS.SIGNALS, { symbol: sym, direction: smcSide, source: 'sol_mtf', ts: Date.now() });
      const prec = this.precision ?? extractPrecisionFromInstrument(null);
      const opened = await this.positionManager.open(smcSide, refPrice, prec, this.pairs.coindcxPair);
      if (opened) {
        setPosition(this.redis, sym, { side: smcSide, entryPrice: opened.entryPrice, qty: opened.quantity, openedAt: opened.openedAt });
        publish(this.redis, CHANNELS.POSITIONS, { event: 'open', symbol: sym, side: smcSide, entryPrice: opened.entryPrice, qty: opened.quantity, ts: Date.now() });
      }
      return;
    }

    const htfBias: TrendBias = biasFromCandles(this.c1h);
    const ltf = analyzeTrend(this.c15);
    const smc = analyzeSmc(this.c15, refPrice, htfBias, { timeframe: '15m' });

    this.log.info('signal_evaluated', {
      htfBias,
      ltfDirection: ltf.direction,
      ltfConfidence: Number(ltf.confidence.toFixed(3)),
      smcScore: smc.score,
      refPrice,
    });

    const aligned =
      htfBias !== 'NONE' &&
      ltf.direction !== 'NONE' &&
      htfBias === ltf.direction;
    const passConfidence = ltf.confidence >= this.cfg.MIN_CONFIDENCE;
    const passSmc = !this.cfg.USE_SMC || smc.score >= this.cfg.MIN_SMC_SCORE;
    const confluence = evaluateSmcConfluence(
      this.c15,
      this.c1h,
      htfBias,
      refPrice,
      {
        enabled: this.cfg.USE_SMC_CONFLUENCE,
        mode: this.cfg.SMC_CONFLUENCE_MODE,
        standardMinScore: this.cfg.SMC_CONFLUENCE_MIN_STANDARD,
        sniperMinScore: this.cfg.SMC_CONFLUENCE_MIN_SNIPER,
        targetPct: this.cfg.SMC_CONFLUENCE_TARGET_PCT,
      },
    );

    this.log.info('smc_confluence', {
      enabled: this.cfg.USE_SMC_CONFLUENCE,
      pass: confluence.pass,
      score: Number(confluence.score.toFixed(2)),
      threshold: confluence.threshold,
      reasons: confluence.reasons,
    });

    if (!aligned || !passConfidence || !passSmc || !confluence.pass) {
      return;
    }

    const side: Side = ltf.direction === 'LONG' ? 'LONG' : 'SHORT';
    const mlResult = await this.runMlGate(side, sym, refPrice);
    if (mlResult === 'blocked') return;

    if (await isKillSwitchActive(this.redis)) {
      this.log.warn('kill_switch_active', { symbol: sym });
      return;
    }

    publish(this.redis, CHANNELS.SIGNALS, {
      symbol: sym, direction: side, htfBias, ltfConfidence: ltf.confidence, smcScore: smc.score, source: 'htf_ltf', ts: Date.now(),
    });
    const prec = this.precision ?? extractPrecisionFromInstrument(null);
    const opened = await this.positionManager.open(side, refPrice, prec, this.pairs.coindcxPair);
    if (opened) {
      setPosition(this.redis, sym, { side, entryPrice: opened.entryPrice, qty: opened.quantity, openedAt: opened.openedAt });
      publish(this.redis, CHANNELS.POSITIONS, { event: 'open', symbol: sym, side, entryPrice: opened.entryPrice, qty: opened.quantity, ts: Date.now() });
    }
  }

  private async runMlGate(
    smcSignal: 'LONG' | 'SHORT',
    symbol: string,
    refPrice: number,
  ): Promise<'pass' | 'blocked'> {
    this.mlVolatilitySizedQty = null;
    this.mlHoldTimeMs = null;

    if (!this.cfg.ML_ENABLED || !this.mlInferenceClient || !this.mlNormalizer) return 'pass';

    const fv = this.buildMlFeatureVector();
    if (!fv) return 'pass';

    const normalized = this.mlNormalizer.normalize(fv);
    const features: Record<string, number> = {};
    for (const [k, v] of Object.entries(normalized)) {
      if (typeof v === 'number') features[k] = v;
    }

    const modelOutput = await this.mlInferenceClient.predict(features);

    if (!modelOutput) {
      this.log.info('ml_inference_unavailable', { fallback: 'rule_based' });
      return 'pass';
    }

    const signal = mlDecide(modelOutput, smcSignal, {
      minProbability: this.cfg.ML_MIN_PROBABILITY,
      minEdgeBps: this.cfg.ML_MIN_EDGE_BPS,
    });

    this.mlPredictionLogger?.logPrediction(
      symbol,
      modelOutput,
      signal ?? 'HOLD',
      refPrice,
    );

    this.log.info('ml_gate', {
      p_up: +modelOutput.p_up.toFixed(3),
      p_down: +modelOutput.p_down.toFixed(3),
      p_flat: +modelOutput.p_flat.toFixed(3),
      smcSignal,
      mlSignal: signal,
      shadow: this.cfg.ML_SHADOW_MODE,
    });

    if (this.cfg.ML_SHADOW_MODE) return 'pass';
    if (signal === null) return 'blocked';

    const execCtx: ExecutionContext = {
      spreadBps: fv.spread_bps,
      bookThinning: fv.book_thinning,
      volRegimeFlag: fv.vol_regime_flag,
      cancelIntensity: fv.cancel_intensity,
      liquidityGap: fv.liquidity_gap,
    };
    const gateResult = shouldSkipEntry(execCtx);
    if (gateResult.skip) {
      this.log.info('execution_gate_skip', { reason: gateResult.reason });
      return 'blocked';
    }

    if (fv.rv_1m > 0) {
      this.mlVolatilitySizedQty = volatilitySizedPosition(1, fv.rv_1m);
      this.log.info('ml_volatility_sizing', { rv1m: +fv.rv_1m.toFixed(6), scale: +this.mlVolatilitySizedQty.toFixed(4) });
    }

    const extended = modelOutput as ExtendedModelOutput;
    if (extended.regime != null || extended.expected_return != null) {
      this.mlHoldTimeMs = optimalHoldTimeMs(extended);
      this.log.info('ml_hold_time', { holdMs: this.mlHoldTimeMs, regime: extended.regime });
    }

    return 'pass';
  }

  private binanceLiveAdapter(): BinanceLiveExecutionAdapter | null {
    const r = this.execution.router;
    if (r) return r.getBinanceLiveAdapter();
    const a = this.execution.adapter;
    return a instanceof BinanceLiveExecutionAdapter ? a : null;
  }

  private scheduleDeadmanAndOrderRatePolling(): void {
    if (!this.execution.binanceRestClient || this.cfg.EXECUTION_MODE !== 'live' || !this.cfg.BINANCE_EXECUTION_ADAPTER) {
      return;
    }
    const client = this.execution.binanceRestClient;
    const cd = this.cfg.BINANCE_DEADMAN_COUNTDOWN_MS;
    if (cd > 0) {
      this.clearDeadmanTimer();
      const tick = Math.max(10_000, Math.floor(cd / 2));
      this.deadmanTimer = setInterval(() => {
        void setCountdownCancelAll(client, { countdownTime: cd }).catch((e) =>
          this.log.warn('binance_deadman_renew_failed', { err: (e as Error).message }),
        );
      }, tick);
      void setCountdownCancelAll(client, { countdownTime: cd }).catch((e) =>
        this.log.warn('binance_deadman_init_failed', { err: (e as Error).message }),
      );
      if (typeof this.deadmanTimer.unref === 'function') this.deadmanTimer.unref();
    }
    if (this.cfg.ORDER_RATE_LIMIT_PAUSE_THRESHOLD > 0) {
      this.clearOrderRateTimer();
      this.orderRateTimer = setInterval(() => void this.refreshOrderRatePause(), 30_000);
      void this.refreshOrderRatePause();
      if (typeof this.orderRateTimer.unref === 'function') this.orderRateTimer.unref();
    }
  }

  private clearDeadmanTimer(): void {
    if (this.deadmanTimer) {
      clearInterval(this.deadmanTimer);
      this.deadmanTimer = null;
    }
  }

  private clearOrderRateTimer(): void {
    if (this.orderRateTimer) {
      clearInterval(this.orderRateTimer);
      this.orderRateTimer = null;
    }
  }

  private async refreshOrderRatePause(): Promise<void> {
    if (!this.execution.binanceRestClient) return;
    try {
      const rows = await getOrderRateLimit(this.execution.binanceRestClient);
      this.applyOrderRateRows(rows);
    } catch (e) {
      this.log.warn('order_rate_limit_fetch_failed', { err: (e as Error).message });
    }
  }

  private applyOrderRateRows(rows: OrderRateLimitRow[]): void {
    const th = this.cfg.ORDER_RATE_LIMIT_PAUSE_THRESHOLD;
    if (th <= 0) return;
    const orderRow = rows.find((r) => String(r.rateLimitType).toUpperCase().includes('ORDER'));
    if (!orderRow || orderRow.limit <= 0) return;
    const ratio = orderRow.count / orderRow.limit;
    const next = ratio >= th;
    if (next !== this.orderRatePauseActive) {
      this.orderRatePauseActive = next;
      this.log.warn('binance_order_rate_pause', {
        active: next,
        count: orderRow.count,
        limit: orderRow.limit,
        ratio: Number(ratio.toFixed(4)),
      });
    }
  }

  private async handleDrawdownKill(walletUsdt: number): Promise<void> {
    if (this.tradingHaltedDrawdown) return;
    this.tradingHaltedDrawdown = true;
    if (!this.drawdownHaltLogged) {
      this.drawdownHaltLogged = true;
      this.log.warn('drawdown_kill_switch', {
        walletUsdt,
        sessionPeakUsdt: this.sessionPeakUsdt,
        pct: this.cfg.DAILY_DRAWDOWN_KILL_PCT,
      });
    }
    const client = this.execution.binanceRestClient;
    const sym = this.pairs.binanceSymbol;
    if (!client) return;
    try {
      await Promise.allSettled([cancelAllAlgoOrders(client, sym), cancelAllOrders(client, sym)]);
    } catch (e) {
      this.log.warn('drawdown_cancel_failed', { err: (e as Error).message });
    }
  }
}
