import { binanceWsBase, type AppConfig } from './config';
import { fetchBinanceKlines } from './binance/rest-klines';
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

export interface OrchestratorDeps {
  cdcx?: CoinDcxFuturesClient;
  ws?: BinanceMarketWs;
  seedKlines?: typeof fetchBinanceKlines;
  execution?: ExecutionRuntime;
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
    this.scheduleHeartbeat();
    this.log.info('orchestrator_started', {
      binance: this.pairs.binanceSymbol,
      coindcx: this.pairs.coindcxPair,
      readOnly: this.cfg.READ_ONLY,
      executionEnabled: this.cfg.EXECUTION_ENABLED,
      ltpCheck: 'Wait for binance_ws_connected then ltp_connected (mark or ticker).',
      logFile: this.cfg.APP_LOG_PATH.trim() || '(stdout only — set APP_LOG_PATH for NDJSON file)',
    });
  }

  stop(): void {
    this.clearHeartbeat();
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
        hint:
          this.cfg.BINANCE_PRODUCT === 'usdm'
            ? 'No markPriceUpdate yet — check network, symbol, or BINANCE_WS_BASE.'
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

  private confirmLtp(source: 'mark' | 'ticker', price: number, eventTime: number): void {
    if (this.ltpConfirmed) return;
    if (!Number.isFinite(price)) return;
    this.ltpConfirmed = true;
    this.clearLtpWatchdog();
    this.log.info('ltp_connected', {
      source,
      price,
      eventTime,
      symbol: this.pairs.binanceSymbol,
      note: source === 'mark' ? 'USD-M mark (used as ref price)' : 'Spot last price from ticker',
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
    this.lastMark = u.markPrice;
    this.confirmLtp('mark', u.markPrice, u.eventTime);
    this.feedSyntheticBook(u.markPrice);
    const sym = this.pairs.binanceSymbol.toUpperCase();
    this.execution.adapter.onMark?.(sym, u.markPrice);
    const htfBias = biasFromCandles(this.c1h);
    void this.positionManager.onMark(u.markPrice, htfBias);
  }

  private onTickerLtp(u: TickerLtpUpdate): void {
    if (u.symbol.toUpperCase() !== this.pairs.binanceSymbol) return;
    this.lastMark = u.lastPrice;
    this.confirmLtp('ticker', u.lastPrice, u.eventTime);
    this.feedSyntheticBook(u.lastPrice);
    const sym = this.pairs.binanceSymbol.toUpperCase();
    this.execution.adapter.onMark?.(sym, u.lastPrice);
    const htfBias = biasFromCandles(this.c1h);
    void this.positionManager.onMark(u.lastPrice, htfBias);
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
