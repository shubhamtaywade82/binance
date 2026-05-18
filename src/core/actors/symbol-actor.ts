import { EventBus } from '../events/event-bus';
import { DomainEvent, SignalPayload, OrderRequestedPayload } from '@coindcx/contracts';
import { MultiTimeframeStore } from '../../binance/multi-tf-store';
import { LocalOrderBook } from '../../binance/orderbook';
import { AggTradeTape } from '../../binance/trade-tape';
import { StrategyModule, StrategyContext } from '../strategy/strategy-module';
import { marketClock } from '../time/market-clock';
import { Candle } from '../../types';

/**
 * SymbolActor — owns all state for one symbol (candles, orderbook, tape, strategies).
 * Lock-free: state never mutated from outside, only via inbound events.
 *
 * M-4: each actor subscribes to its four event types directly rather than
 * walking every published event through a wildcard subscribeAll filter.
 * Pre-fix, with N actors and an EventBus delivering K events/sec, the
 * dispatch cost was O(N·K) per event — on a 50-symbol watchlist with
 * dense bookticker / trade streams that's ~50× wasted iteration per tick.
 */
export class SymbolActor {
  private readonly store = new MultiTimeframeStore({ maxBars: 1000 });
  private readonly book = new LocalOrderBook();
  private readonly tape = new AggTradeTape(1000);
  private readonly strategies: StrategyModule[] = [];
  private readonly executionTf: string;
  private readonly subscriptions: Array<{ unsubscribe: () => void }> = [];
  private seq = 0;

  constructor(
    public readonly symbol: string,
    private readonly eventBus: EventBus,
    opts: { executionTf?: string } = {},
  ) {
    this.executionTf = opts.executionTf ?? '1m';
    this.subscribe();
  }

  public addStrategy(factory: (ctx: StrategyContext) => StrategyModule): StrategyModule {
    const ctx: StrategyContext = {
      symbol: this.symbol,
      timeframe: this.executionTf,
      getHistory: (tf?: string) => this.store.getSeries(this.symbol, tf ?? this.executionTf),
      eventBus: this.eventBus,
    };
    const strategy = factory(ctx);
    this.strategies.push(strategy);
    return strategy;
  }

  /** For seeding from REST/historical fetch before live feed starts. */
  public seed(tf: string, candles: Candle[]): void {
    this.store.seed(this.symbol, tf, candles);
  }

  /** Detach all bus subscriptions. Called by ActorSystem.shutdown(). */
  public dispose(): void {
    for (const s of this.subscriptions) s.unsubscribe();
    this.subscriptions.length = 0;
  }

  private subscribe(): void {
    // M-4: per-type targeted subscriptions, each one filtered by symbol.
    // Stored so dispose() can detach them on shutdown.
    const onlyMine = (handler: (e: DomainEvent<any>) => void) => (e: DomainEvent<any>) => {
      if (e.symbol !== this.symbol) return;
      handler(e);
    };
    this.subscriptions.push(
      this.eventBus.subscribe('market.kline.closed', onlyMine((e) => this.handleKline(e))),
      this.eventBus.subscribe('market.trade', onlyMine((e) => this.handleTrade(e))),
      this.eventBus.subscribe('market.depth.delta', onlyMine((e) => this.handleDepth(e))),
      this.eventBus.subscribe('market.bookticker', onlyMine((e) => this.handleBookTicker(e))),
    );
  }

  private handleKline(event: DomainEvent<any>): void {
    const payload = event.payload;
    const candle: Candle = {
      openTime: payload.openTime,
      closeTime: payload.closeTime,
      open: payload.open,
      high: payload.high,
      low: payload.low,
      close: payload.close,
      volume: payload.volume,
    };
    const tf: string = payload.timeframe || payload.tf || this.executionTf;
    this.store.applyKline(this.symbol, tf, candle, true);

    // Strategies only run on their execution timeframe.
    if (tf !== this.executionTf) return;

    for (const strategy of this.strategies) {
      const result = strategy.onKline(candle);
      if (result) this.emitResult(strategy.getName(), result);
    }
  }

  private handleTrade(event: DomainEvent<any>): void {
    const p = event.payload;
    this.tape.push({ price: p.price, qty: p.quantity, ts: p.timestamp, makerSide: p.isBuyerMaker });
    for (const s of this.strategies) {
      if (!s.onTrade) continue;
      const r = s.onTrade(p.price, p.quantity, p.isBuyerMaker);
      if (r) this.emitResult(s.getName(), r);
    }
  }

  private handleDepth(event: DomainEvent<any>): void {
    const p = event.payload;
    this.book.applyDiff({
      U: p.firstUpdateId,
      u: p.finalUpdateId,
      bids: p.bids,
      asks: p.asks,
      E: p.timestamp,
    });
    for (const s of this.strategies) {
      if (!s.onBookUpdate) continue;
      const bid = this.book.bestBid()?.price ?? 0;
      const ask = this.book.bestAsk()?.price ?? 0;
      const r = s.onBookUpdate(bid, ask);
      if (r) this.emitResult(s.getName(), r);
    }
  }

  private handleBookTicker(event: DomainEvent<any>): void {
    const p = event.payload;
    for (const s of this.strategies) {
      if (!s.onBookUpdate) continue;
      const r = s.onBookUpdate(p.bestBidPrice, p.bestAskPrice);
      if (r) this.emitResult(s.getName(), r);
    }
  }

  private emitResult(strategyId: string, result: SignalPayload | OrderRequestedPayload): void {
    const isOrder = 'side' in result && 'quantity' in result;
    const type = isOrder ? 'execution.order.requested' : 'strategy.signal';
    this.seq += 1;
    this.eventBus.publish({
      id: `${type}-${this.symbol}-${marketClock.now()}-${this.seq}`,
      type,
      ts: marketClock.now(),
      source: `actor:${this.symbol}:${strategyId}`,
      symbol: this.symbol,
      payload: result,
    });
  }
}
