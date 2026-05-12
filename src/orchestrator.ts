import { binanceWsBase, binanceRestBase, type AppConfig } from './config';
import { fetchBinanceKlines } from './binance/rest-klines';
import { fetchUsdmMarkFromRest } from './binance/rest-premium-index';
import { BinanceMarketWs, type MarkPriceUpdate, type TickerLtpUpdate } from './binance/ws-streams';
import {
  BinanceMultiplexWs,
  type AggTradeEvent,
  type BookTickerEvent,
  type DepthLevels,
  type DepthSpeed,
  type MultiplexCallbacks,
} from './binance/ws-multiplex';
import { mergeMultiplexCallbacks } from './binance/merge-multiplex-callbacks';
import { MultiTimeframeStore } from './binance/multi-tf-store';
import { LocalOrderBook } from './binance/orderbook';
import { AggTradeTape } from './binance/trade-tape';
import { fetchHistoricalKlines } from './binance/historical';
import { fetchBinanceDepthSnapshot } from './binance/rest-depth';
import { fetchBinanceExchangeInfo } from './binance/rest-exchange-info';
import { BinancePrivateWs } from './binance/private-ws';
import { getPositionRisk, getOpenAlgoOrders } from './binance/rest-trade';
import { CoinDcxFuturesClient } from './coindcx/futures-client';
import { extractPrecisionFromInstrument, type InstrumentPrecision } from './mapping/precision';
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
  /** Override for tests; default fetches Binance exchangeInfo. */
  fetchExchangeInfo?: typeof fetchBinanceExchangeInfo;
  /** Merged after internal multiplex primary callbacks (e.g. dashboard WebSocket bridge). Ignored when `deps.multiplex` is set. */
  multiplexSidecar?: MultiplexCallbacks;
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
  private readonly fetchHistorical: typeof fetchHistoricalKlines;
  private readonly fetchDepth: typeof fetchBinanceDepthSnapshot;
  private readonly fetchExchangeInfo: typeof fetchBinanceExchangeInfo;
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
  private orderbookBootstrapInflight = false;
  /** Private user-data stream — non-null when BINANCE_EXECUTION_ADAPTER=true + live. */
  private privateWs: BinancePrivateWs | null = null;

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
    this.fetchExchangeInfo = deps.fetchExchangeInfo ?? fetchBinanceExchangeInfo;
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
          symbols: [cfg.BINANCE_SYMBOL.trim().toUpperCase()],
          timeframes: this.timeframes,
          product: cfg.BINANCE_PRODUCT,
          useBookTicker: cfg.BINANCE_USE_BOOKTICKER,
          useAggTrade: cfg.BINANCE_USE_AGGTRADE,
          depthLevels: cfg.BINANCE_DEPTH_LEVELS as DepthLevels,
          depthSpeed: cfg.BINANCE_DEPTH_SPEED as DepthSpeed,
          useMarkPrice: cfg.BINANCE_USE_MARK_PRICE,
          useForceOrder: cfg.BINANCE_USE_FORCE_ORDER,
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
          onListenKeyExpired: () => this.log.warn('binance_listen_key_expired', {}),
          onError: (err) => this.log.warn('binance_private_ws_error', { err: err.message }),
          onReconnect: (n) => this.log.warn('binance_private_ws_reconnect', { attempt: n }),
          onOpen: () => this.log.info('binance_private_ws_connected', { symbol: this.pairs.binanceSymbol }),
          onClose: () => this.log.info('binance_private_ws_closed', {}),
        },
      });
    }
  }

  async start(): Promise<void> {
    await this.seedCandles();
    await this.loadPrecision();

    // Push exchange precision into the Binance adapter and reconcile any open position.
    if (this.cfg.BINANCE_EXECUTION_ADAPTER && this.execution.binanceRestClient) {
      const binanceAdapter = this.execution.adapter as BinanceLiveExecutionAdapter;
      if (this.precision) binanceAdapter.setPrecision(this.precision);
      await this.reconcileExchangePosition(binanceAdapter);
    }

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
        this.cfg.BINANCE_PRODUCT === 'usdm' ? this.cfg.USDM_MARK_REST_POLL_SEC : 0,
      ltpCheck: 'Wait for binance_ws_connected then ltp_connected (mark, mark_rest, or ticker).',
      logFile: this.cfg.APP_LOG_PATH.trim() || '(stdout only — set APP_LOG_PATH for NDJSON file)',
    });
  }

  stop(): void {
    this.clearHeartbeat();
    this.clearRestMarkPoll();
    this.clearLtpWatchdog();
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
      onMarkPrice: (u) => this.onMark({ symbol: u.symbol, markPrice: u.markPrice, eventTime: u.eventTime }),
      on24hrTicker: (u) => this.onTickerLtp({ symbol: u.symbol, lastPrice: u.lastPrice, eventTime: u.eventTime }),
      onDepthDiff: (d) => this.onDepthDiffEvent(d),
      onDepthPartial: (p) => this.onDepthPartialEvent(p),
      onServerShutdown: () => this.log.warn('binance_ws_server_shutdown', {}),
      onOpen: (route, url) => this.onWsOpen(route, url),
      onError: (e) => this.log.warn('binance_ws_error', { err: e.message }),
      onReconnect: (n, reason) => this.onWsReconnectMx(n, reason),
    };
  }

  private onWsReconnectMx(attempt: number, reason: string): void {
    this.log.warn('binance_ws_reconnect', { attempt, reason });
    this.ltpConfirmed = false;
    this.scheduleLtpWatchdog();
  }

  private onMultiplexKline(symbol: string, tf: string, candle: Candle, isFinal: boolean): void {
    if (symbol.toUpperCase() !== this.pairs.binanceSymbol) return;
    this.store.applyKline(symbol, tf, candle, isFinal);
    if (tf === this.ltfTf) {
      const series = this.store.getSeries(symbol, this.ltfTf);
      this.c15.splice(0, this.c15.length, ...series);
    } else if (tf === this.htfTf) {
      const series = this.store.getSeries(symbol, this.htfTf);
      this.c1h.splice(0, this.c1h.length, ...series);
    }
    if (isFinal && tf === this.ltfTf) void this.evaluate(candle);
  }

  private onBookTicker(t: BookTickerEvent): void {
    if (t.symbol.toUpperCase() !== this.pairs.binanceSymbol) return;
    this.book.ingest({
      symbol: t.symbol.toUpperCase(),
      bestBid: t.bestBid,
      bestAsk: t.bestAsk,
      spread: t.bestAsk - t.bestBid,
      ts: t.ts,
    });
  }

  private onAggTradeEvent(t: AggTradeEvent): void {
    if (t.symbol.toUpperCase() !== this.pairs.binanceSymbol) return;
    this.tradeTape.push({ price: t.price, qty: t.qty, ts: t.ts, makerSide: t.makerSide });
    this.book.ingestTrade(t.symbol.toUpperCase(), t.price);
  }

  private onDepthDiffEvent(d: import('./binance/orderbook').DepthDiff & { s: string }): void {
    if (d.s.toUpperCase() !== this.pairs.binanceSymbol) return;
    if (this.cfg.BINANCE_DEPTH_LEVELS > 0) return;
    if (!this.orderbook.isBootstrapped()) {
      this.orderbook.buffer(d);
      if (!this.orderbookBootstrapInflight) {
        this.orderbookBootstrapInflight = true;
        void this.finishDiffDepthBootstrap();
      }
      return;
    }
    this.orderbook.applyDiff(d);
  }

  private onDepthPartialEvent(p: import('./binance/ws-multiplex').DepthPartialEvent): void {
    const symU = this.pairs.binanceSymbol.toUpperCase();
    if (p.symbol && p.symbol.toUpperCase() !== symU) return;
    this.orderbook.replaceFromPartial({ bids: p.bids, asks: p.asks });
  }

  /** After buffering diff events, align REST snapshot then replay (Binance depth procedure). */
  private async finishDiffDepthBootstrap(): Promise<void> {
    try {
      if (this.orderbook.isBootstrapped()) return;
      const snap = await this.fetchDepth(this.cfg, this.pairs.binanceSymbol, 1000);
      if (snap) {
        this.orderbook.bootstrap(snap);
        this.log.info('orderbook_bootstrapped', { lastUpdateId: snap.lastUpdateId });
      } else {
        this.log.warn('orderbook_bootstrap_empty', { symbol: this.pairs.binanceSymbol });
      }
    } catch (e) {
      this.log.warn('orderbook_bootstrap_failed', { err: (e as Error).message });
    } finally {
      this.orderbookBootstrapInflight = false;
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
    this.log.info('heartbeat', {
      binanceMark: this.lastMark,
      ltpConfirmed: this.ltpConfirmed,
      htfBias,
      ltfBias,
      execTf: this.ltfTf,
      barsExec: this.c15.length,
      barsHTF: this.c1h.length,
      inPosition: this.positionManager.hasPosition(),
    });
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
          this.cfg.BINANCE_PRODUCT === 'usdm'
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

  setPrecision(p: InstrumentPrecision): void {
    this.precision = p;
  }

  async evaluateBar(bar: Candle): Promise<void> {
    return this.evaluate(bar);
  }

  private async seedCandles(): Promise<void> {
    if (this.multiplex) {
      const limit = this.cfg.BINANCE_HISTORY_BARS ?? 500;
      const sym = this.pairs.binanceSymbol;
      for (const tf of this.timeframes) {
        try {
          const bars = await this.seed(this.cfg, { symbol: sym, interval: tf, limit });
          this.store.seed(sym, tf, bars);
        } catch (e) {
          this.log.warn('candles_seed_failed', { tf, err: (e as Error).message });
        }
      }
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
    // Try Binance exchangeInfo first (authoritative for FAPI symbols).
    if (this.cfg.BINANCE_PRODUCT === 'usdm') {
      try {
        const p = await this.fetchExchangeInfo(
          binanceRestBase(this.cfg),
          this.pairs.binanceSymbol,
        );
        if (p) {
          this.precision = p;
          this.log.info('instrument_precision', {
            source: 'binance_exchange_info',
            ...this.precision,
          });
          return;
        }
      } catch (e) {
        this.log.warn('binance_exchange_info_failed', { err: (e as Error).message });
      }
    }
    // Fall back to CoinDCX instrument details.
    try {
      const raw = await this.cdcx.getFuturesInstrumentDetails(this.pairs.coindcxPair);
      this.precision = extractPrecisionFromInstrument(raw);
      this.log.info('instrument_precision', {
        source: 'coindcx',
        ...this.precision as unknown as Record<string, unknown>,
      });
    } catch (e) {
      this.log.warn('instrument_precision_failed', { err: (e as Error).message });
      this.precision = extractPrecisionFromInstrument(null);
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
    if (ltpSource === 'ticker') this.confirmLtp('ticker', price, eventTime);
    else this.confirmLtp(ltpSource, price, eventTime);
    const symU = this.pairs.binanceSymbol.toUpperCase();
    const liveBook =
      this.cfg.BINANCE_USE_BOOKTICKER && this.multiplex !== null && this.book.latest(symU);
    if (!liveBook) this.feedSyntheticBook(price);
    const sym = this.pairs.binanceSymbol.toUpperCase();
    this.execution.adapter.onMark?.(sym, price);
    void this.positionManager.onMark(price, this.reversalTrendBias());
  }

  private scheduleRestMarkPoll(): void {
    this.clearRestMarkPoll();
    if (this.cfg.BINANCE_PRODUCT !== 'usdm') return;
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
    if (this.cfg.BINANCE_PRODUCT !== 'usdm') return;
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
      const binanceAdapter = this.execution.adapter as BinanceLiveExecutionAdapter;
      const fillPrice = Number(o.ap) || Number(o.L) || this.lastMark || 0;
      if (fillPrice > 0) {
        const result = binanceAdapter.notifyFilled(o.si, fillPrice);
        if (result?.fullyFilled) {
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
      const [positions, algoOrders] = await Promise.all([
        getPositionRisk(client, sym),
        getOpenAlgoOrders(client, sym),
      ]);
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

      const side: Side = sol.direction === 'LONG' ? 'LONG' : 'SHORT';
      const prec = this.precision ?? extractPrecisionFromInstrument(null);
      await this.positionManager.open(side, refPrice, prec, this.pairs.coindcxPair);
      return;
    }

    const htfBias: TrendBias = biasFromCandles(this.c1h);
    const ltf = analyzeTrend(this.c15);
    const smc = analyzeSmc(this.c15, refPrice, htfBias);

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
    const prec = this.precision ?? extractPrecisionFromInstrument(null);
    await this.positionManager.open(side, refPrice, prec, this.pairs.coindcxPair);
  }
}
