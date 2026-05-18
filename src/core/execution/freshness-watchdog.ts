import type { EventBus } from '../events/event-bus';
import type { DomainEvent } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';

export interface FreshnessWatchdogOptions {
  /**
   * After this much wall-clock time with no observed event from a market
   * source for a symbol, the watchdog publishes `system.stale` for that
   * symbol. Default 30s — long enough to ride out a single missed kline on
   * a fast TF but short enough to detect a real feed loss.
   */
  staleAfterMs?: number;
  /** How often to scan the lastSeen map. Default 5s. */
  checkIntervalMs?: number;
  /** Event types that count as freshness signals. Default kline/bookticker/mark. */
  freshTypes?: string[];
  /** Optional logger for debug surface. */
  log?: { info(msg: string, meta?: Record<string, unknown>): void; warn(msg: string, meta?: Record<string, unknown>): void };
  /** Override for testability. */
  now?: () => number;
}

interface SymbolState {
  /** Most recent freshness signal per symbol per source. */
  lastBySource: Map<string, number>;
  /** Whether the symbol is currently flagged stale (to avoid duplicate events). */
  stale: boolean;
  /** Reason captured at the moment we transition to stale, for the published event payload. */
  staleSources: string[];
}

/**
 * FreshnessWatchdog — feeds-availability invariant on the event bus.
 *
 * Subscribes to market events (kline closed, bookticker, mark price) and tracks
 * the wall-clock time of the most recent observation per (symbol, source). On a
 * periodic timer it transitions a symbol to STALE when no source has reported
 * within `staleAfterMs`, and back to FRESH when at least one source reports
 * again. Each transition is published as `system.stale` / `system.fresh` so
 * downstream consumers (RiskEngine, dashboard, alerting) can react.
 *
 * Without this watchdog, a silent feed loss (rotate_24h reconnect storm,
 * fstream maintenance, transient network drop) lets the strategy keep firing
 * on the cached kline close while CoinDCX/Binance prices move freely away
 * from the bot's view.
 */
export class FreshnessWatchdog {
  private readonly bus: EventBus;
  private readonly staleAfterMs: number;
  private readonly checkIntervalMs: number;
  private readonly nowFn: () => number;
  private readonly log?: FreshnessWatchdogOptions['log'];
  private readonly symbols = new Map<string, SymbolState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  /** Started? */
  private started = false;

  constructor(bus: EventBus, opts: FreshnessWatchdogOptions = {}) {
    this.bus = bus;
    this.staleAfterMs = opts.staleAfterMs ?? 30_000;
    this.checkIntervalMs = opts.checkIntervalMs ?? 5_000;
    this.nowFn = opts.now ?? (() => Date.now());
    this.log = opts.log;
    const types = opts.freshTypes ?? ['market.kline.closed', 'market.bookticker', 'market.mark'];
    for (const t of types) {
      this.bus.subscribe(t, (e: DomainEvent<any>) => this.recordFresh(e, t));
    }
  }

  /** Begin periodic staleness scanning. Safe to call once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.scan(), this.checkIntervalMs);
    if (typeof (this.timer as any).unref === 'function') (this.timer as any).unref();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Test hook: feed an arbitrary fresh observation. */
  public recordFreshness(symbol: string, source: string): void {
    if (!symbol) return;
    const state = this.symbols.get(symbol) ?? this.allocate(symbol);
    state.lastBySource.set(source, this.nowFn());
  }

  /** Test hook: synchronous scan. */
  public scanNow(): void {
    this.scan();
  }

  /** Snapshot of currently-stale symbols (caller-mutation-safe). */
  public staleSymbols(): string[] {
    const out: string[] = [];
    for (const [sym, state] of this.symbols.entries()) {
      if (state.stale) out.push(sym);
    }
    return out;
  }

  private allocate(symbol: string): SymbolState {
    const s: SymbolState = { lastBySource: new Map(), stale: false, staleSources: [] };
    this.symbols.set(symbol, s);
    return s;
  }

  private recordFresh(e: DomainEvent<any>, eventType: string): void {
    const sym: string | undefined = e.symbol ?? e.payload?.symbol;
    if (!sym) return;
    const state = this.symbols.get(sym) ?? this.allocate(sym);
    state.lastBySource.set(eventType, this.nowFn());
    if (state.stale) {
      // Transition stale → fresh as soon as a single source reports again.
      state.stale = false;
      state.staleSources = [];
      this.publishFresh(sym, eventType);
    }
  }

  private scan(): void {
    const now = this.nowFn();
    for (const [symbol, state] of this.symbols.entries()) {
      if (state.lastBySource.size === 0) continue;
      const staleSources: string[] = [];
      for (const [source, ts] of state.lastBySource.entries()) {
        if (now - ts > this.staleAfterMs) staleSources.push(source);
      }
      const isStale = staleSources.length === state.lastBySource.size && state.lastBySource.size > 0;
      if (isStale && !state.stale) {
        state.stale = true;
        state.staleSources = staleSources;
        this.publishStale(symbol, staleSources);
      }
    }
  }

  private publishStale(symbol: string, sources: string[]): void {
    this.seq += 1;
    this.log?.warn('system_stale', { symbol, sources, thresholdMs: this.staleAfterMs });
    this.bus.publish({
      id: `system-stale-${symbol}-${this.nowFn()}-${this.seq}`,
      type: 'system.stale',
      ts: marketClock.now(),
      source: 'freshness-watchdog',
      symbol,
      payload: { symbol, sources, thresholdMs: this.staleAfterMs },
    });
  }

  private publishFresh(symbol: string, recoveredSource: string): void {
    this.seq += 1;
    this.log?.info('system_fresh', { symbol, recoveredSource });
    this.bus.publish({
      id: `system-fresh-${symbol}-${this.nowFn()}-${this.seq}`,
      type: 'system.fresh',
      ts: marketClock.now(),
      source: 'freshness-watchdog',
      symbol,
      payload: { symbol, recoveredSource },
    });
  }
}
