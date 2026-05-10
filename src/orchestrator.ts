import { binanceWsBase, type AppConfig } from './config';
import { fetchBinanceKlines } from './binance/rest-klines';
import { BinanceMarketWs, type MarkPriceUpdate } from './binance/ws-streams';
import { CoinDcxFuturesClient } from './coindcx/futures-client';
import { extractPrecisionFromInstrument, floorToStep } from './mapping/precision';
import { resolvePairMap, type ResolvedPairMap } from './mapping/symbol-map';
import { alignedTrend, biasFromCandles } from './strategy/htf-ltf';
import type { Candle, TrendBias } from './types';

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

export class HybridOrchestrator {
  private readonly pairs: ResolvedPairMap;
  private readonly c15: Candle[] = [];
  private readonly c1h: Candle[] = [];
  private readonly ws: BinanceMarketWs;
  private readonly cdcx: CoinDcxFuturesClient;
  private lastMark: number | null = null;
  private lastMarkAt: number | null = null;
  private lastSignal: TrendBias = 'NONE';
  private precision: ReturnType<typeof extractPrecisionFromInstrument> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly log: OrchestratorLogger = consoleLogger,
  ) {
    this.pairs = resolvePairMap(cfg);
    this.cdcx = new CoinDcxFuturesClient({
      apiKey: cfg.COINDCX_API_KEY,
      apiSecret: cfg.COINDCX_API_SECRET,
      apiBaseUrl: cfg.API_BASE_URL,
      readOnly: cfg.READ_ONLY,
    });
    this.ws = new BinanceMarketWs(cfg, {
      onKline: (c, fin) => this.onKline(c, fin),
      onMarkPrice: (u) => this.onMark(u),
      onOpen: () => this.logWsConnected(),
      onError: (err) => this.log.warn('binance_ws_error', { err: err.message }),
      onReconnect: (n) => this.log.warn('binance_ws_reconnect', { attempt: n }),
    });
  }

  async start(): Promise<void> {
    await this.seedCandles();
    await this.loadPrecision();
    this.ws.start();
    this.log.info('orchestrator_started', {
      binance: this.pairs.binanceSymbol,
      coindcx: this.pairs.coindcxPair,
      readOnly: this.cfg.READ_ONLY,
      executionEnabled: this.cfg.EXECUTION_ENABLED,
    });
    this.log.info('runtime_help', {
      next: 'Wait for binance_ws_connected, then mark/klines flow.',
      barLog: `Each closed ${this.cfg.BINANCE_KLINE_INTERVAL} bar logs ltf_bar_closed (bias + aligned signal).`,
      signalLog: 'Aligned HTF/LTF change logs signal + paper_or_readonly_skip_order when not trading.',
      heartbeatSec: this.cfg.LOG_HEARTBEAT_SEC,
    });
    if (this.cfg.LOG_HEARTBEAT_SEC > 0) {
      this.heartbeatTimer = setInterval(() => this.logHeartbeat(), this.cfg.LOG_HEARTBEAT_SEC * 1000);
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.ws.stop();
  }

  private logWsConnected(): void {
    const base = binanceWsBase(this.cfg);
    this.log.info('binance_ws_connected', {
      wsBase: base,
      symbol: this.pairs.binanceSymbol,
      ltf: this.cfg.BINANCE_KLINE_INTERVAL,
      htfPoll: this.cfg.BINANCE_HTF_INTERVAL,
    });
  }

  private logHeartbeat(): void {
    const htfBias = biasFromCandles(this.c1h);
    const ltfBias = biasFromCandles(this.c15);
    const aligned = alignedTrend(htfBias, ltfBias);
    const last15 = this.c15.length ? this.c15[this.c15.length - 1] : null;
    this.log.info('heartbeat', {
      binanceMark: this.lastMark,
      markEventMs: this.lastMarkAt,
      htfBias,
      ltfBias,
      alignedSignal: aligned,
      lastEmittedSignal: this.lastSignal,
      last15mOpenTime: last15?.openTime,
      last15mClose: last15?.close,
      bars15m: this.c15.length,
      bars1h: this.c1h.length,
    });
  }

  private async seedCandles(): Promise<void> {
    const [h15, h1h] = await Promise.all([
      fetchBinanceKlines(this.cfg, {
        symbol: this.pairs.binanceSymbol,
        interval: this.cfg.BINANCE_KLINE_INTERVAL,
        limit: 200,
      }),
      fetchBinanceKlines(this.cfg, {
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
    this.lastMarkAt = u.eventTime;
  }

  private onKline(c: Candle, isFinal: boolean): void {
    upsertCandle(this.c15, c);
    if (isFinal) {
      void this.onLtfBarFinal(c);
    }
  }

  private async onLtfBarFinal(c: Candle): Promise<void> {
    await this.maybeRefreshHtf();
    const htfBias = biasFromCandles(this.c1h);
    const ltfBias = biasFromCandles(this.c15);
    const aligned = alignedTrend(htfBias, ltfBias);
    this.log.info('ltf_bar_closed', {
      openTime: c.openTime,
      close: c.close,
      htfBias,
      ltfBias,
      aligned,
      binanceMark: this.lastMark,
    });
    this.evaluate(c);
  }

  /** Refresh 1h series periodically on LTF close (cheap vs streaming two WS). */
  private async maybeRefreshHtf(): Promise<void> {
    try {
      const h = await fetchBinanceKlines(this.cfg, {
        symbol: this.pairs.binanceSymbol,
        interval: this.cfg.BINANCE_HTF_INTERVAL,
        limit: 120,
      });
      this.c1h.splice(0, this.c1h.length, ...h);
    } catch (e) {
      this.log.warn('htf_refresh_failed', { err: (e as Error).message });
    }
  }

  private evaluate(ltfBar: Candle): void {
    const htfBias = biasFromCandles(this.c1h);
    const ltfBias = biasFromCandles(this.c15);
    const signal = alignedTrend(htfBias, ltfBias);
    if (signal === this.lastSignal) return;
    this.lastSignal = signal;
    if (signal === 'NONE') {
      this.log.info('signal_none', { htfBias, ltfBias, ltfClose: ltfBar.close });
      return;
    }
    void this.handleSignal(signal, ltfBar.close);
  }

  private async handleSignal(side: Exclude<TrendBias, 'NONE'>, referencePrice: number): Promise<void> {
    const prec = this.precision ?? extractPrecisionFromInstrument(null);
    const notionQty = 0.01;
    const qty = floorToStep(notionQty, prec.stepSize);
    const mark = this.lastMark ?? referencePrice;

    const canExecute =
      this.cfg.EXECUTION_ENABLED &&
      !this.cfg.READ_ONLY &&
      Boolean(this.cfg.COINDCX_API_KEY.trim()) &&
      Boolean(this.cfg.COINDCX_API_SECRET.trim());

    this.log.info('signal', {
      side,
      pair: this.pairs.coindcxPair,
      binanceMark: mark,
      referenceClose: referencePrice,
      qty,
      paper: !canExecute,
    });

    if (!canExecute) {
      this.log.info('paper_or_readonly_skip_order', {
        EXECUTION_ENABLED: this.cfg.EXECUTION_ENABLED,
        READ_ONLY: this.cfg.READ_ONLY,
      });
      return;
    }

    try {
      const sideStr = side === 'LONG' ? 'buy' : 'sell';
      await this.cdcx.createFuturesOrder({
        pair: this.pairs.coindcxPair,
        side: sideStr,
        order_type: 'market',
        price: null,
        stop_price: null,
        total_quantity: qty,
        notification: 'no_notification',
        margin_currency_short_name: 'USDT',
      });
      this.log.info('order_submitted', { side: sideStr, qty });
    } catch (e) {
      this.log.warn('order_failed', { err: (e as Error).message });
    }
  }
}
