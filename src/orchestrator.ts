import { binanceWsBase, type AppConfig } from './config';
import { fetchBinanceKlines } from './binance/rest-klines';
import { fetchUsdmMarkFromRest } from './binance/rest-premium-index';
import { BinanceMarketWs, type MarkPriceUpdate, type TickerLtpUpdate } from './binance/ws-streams';
import { CoinDcxFuturesClient } from './coindcx/futures-client';
import { extractPrecisionFromInstrument, type InstrumentPrecision } from './mapping/precision';
import { resolvePairMap, type ResolvedPairMap } from './mapping/symbol-map';
import { biasFromCandles } from './strategy/htf-ltf';
import { analyzeTrend } from './strategy/trend';
import { analyzeSmc } from './strategy/smc';
import { RiskManager } from './strategy/risk';
import { PositionManager } from './strategy/position-manager';
import type { Candle, Side, TrendBias } from './types';
import { createExecutionRuntime, type ExecutionRuntime } from './execution/create-runtime';
import type { BookTickerFeed } from './execution/paper/book-ticker-feed';

function upsertCandle(series: Candle[], bar: Candle): void {
  const idx = series.findIndex((c) => c.openTime === bar.openTime);
  if (idx >= 0) series[idx] = bar;
  else series.push(bar);
  series.sort((a, b) => a.openTime - b.openTime);
  const max = 600;
  if (series.length > max) series.splice(0, series.length - max);
}

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
  seedKlines?: typeof fetchBinanceKlines;
  execution?: ExecutionRuntime;
  /** Override for tests; default polls Binance `premiumIndex`. */
  fetchUsdmMarkRest?: UsdmMarkRestFetch;
}

export class HybridOrchestrator {
  private readonly pairs: ResolvedPairMap;
  private readonly c15: Candle[] = [];
  private readonly c1h: Candle[] = [];
  private readonly ws: BinanceMarketWs;
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
    this.ws = deps.ws ?? new BinanceMarketWs(cfg, {
      onOpen: () => this.onWsOpen(),
      onKline: (c, fin) => this.onKline(c, fin),
      onMarkPrice: (u) => this.onMark(u),
      onTickerLtp: (u) => this.onTickerLtp(u),
      onError: (err) => this.log.warn('binance_ws_error', { err: err.message }),
      onReconnect: (n) => this.onWsReconnect(n),
    });
  }

  async start(): Promise<void> {
    await this.seedCandles();
    await this.loadPrecision();
    this.ws.start();
    this.scheduleLtpWatchdog();
    this.scheduleRestMarkPoll();
    this.scheduleHeartbeat();
    this.log.info('orchestrator_started', {
      binance: this.pairs.binanceSymbol,
      coindcx: this.pairs.coindcxPair,
      readOnly: this.cfg.READ_ONLY,
      executionEnabled: this.cfg.EXECUTION_ENABLED,
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
    this.ws.stop();
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
    const htfBias = biasFromCandles(this.c1h);
    const ltfBias = biasFromCandles(this.c15);
    this.log.info('heartbeat', {
      binanceMark: this.lastMark,
      ltpConfirmed: this.ltpConfirmed,
      htfBias,
      ltfBias,
      bars15m: this.c15.length,
      bars1h: this.c1h.length,
      inPosition: this.positionManager.hasPosition(),
    });
  }

  private onWsOpen(): void {
    this.log.info('binance_ws_connected', {
      wsBase: binanceWsBase(this.cfg),
      product: this.cfg.BINANCE_PRODUCT,
      symbol: this.pairs.binanceSymbol,
      ltf: this.cfg.BINANCE_KLINE_INTERVAL,
    });
  }

  private onWsReconnect(attempt: number): void {
    this.log.warn('binance_ws_reconnect', { attempt });
    this.ltpConfirmed = false;
    this.scheduleLtpWatchdog();
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

  injectCandles(c15: Candle[], c1h: Candle[]): void {
    this.c15.splice(0, this.c15.length, ...c15);
    this.c1h.splice(0, this.c1h.length, ...c1h);
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

  private async loadPrecision(): Promise<void> {
    try {
      const raw = await this.cdcx.getFuturesInstrumentDetails(this.pairs.coindcxPair);
      this.precision = extractPrecisionFromInstrument(raw);
      this.log.info('instrument_precision', this.precision as unknown as Record<string, unknown>);
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
    this.feedSyntheticBook(price);
    const sym = this.pairs.binanceSymbol.toUpperCase();
    this.execution.adapter.onMark?.(sym, price);
    const htfBias = biasFromCandles(this.c1h);
    void this.positionManager.onMark(price, htfBias);
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

  private onKline(c: Candle, isFinal: boolean): void {
    upsertCandle(this.c15, c);
    if (isFinal) {
      void this.maybeRefreshHtf().then(() => this.evaluate(c));
    }
  }

  private async maybeRefreshHtf(): Promise<void> {
    try {
      const h = await this.seed(this.cfg, {
        symbol: this.pairs.binanceSymbol,
        interval: this.cfg.BINANCE_HTF_INTERVAL,
        limit: 120,
      });
      this.c1h.splice(0, this.c1h.length, ...h);
    } catch (e) {
      this.log.warn('htf_refresh_failed', { err: (e as Error).message });
    }
  }

  private async evaluate(ltfBar: Candle): Promise<void> {
    const htfBias: TrendBias = biasFromCandles(this.c1h);
    const ltf = analyzeTrend(this.c15);
    const refPrice = this.lastMark ?? ltfBar.close;
    const smc = analyzeSmc(this.c15, refPrice, htfBias);

    this.log.info('signal_evaluated', {
      htfBias,
      ltfDirection: ltf.direction,
      ltfConfidence: Number(ltf.confidence.toFixed(3)),
      smcScore: smc.score,
      refPrice,
    });

    if (this.positionManager.hasPosition()) return;

    const aligned =
      htfBias !== 'NONE' &&
      ltf.direction !== 'NONE' &&
      htfBias === ltf.direction;
    const passConfidence = ltf.confidence >= this.cfg.MIN_CONFIDENCE;
    const passSmc = !this.cfg.USE_SMC || smc.score >= this.cfg.MIN_SMC_SCORE;

    if (!aligned || !passConfidence || !passSmc) {
      return;
    }

    const side: Side = ltf.direction === 'LONG' ? 'LONG' : 'SHORT';
    const prec = this.precision ?? extractPrecisionFromInstrument(null);
    await this.positionManager.open(side, refPrice, prec, this.pairs.coindcxPair);
  }
}
