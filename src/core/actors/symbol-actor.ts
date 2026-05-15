import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { MultiTimeframeStore } from '../../binance/multi-tf-store';
import { LocalOrderBook } from '../../binance/orderbook';
import { AggTradeTape } from '../../binance/trade-tape';
import { StrategyModule } from '../strategy/strategy-module';
import { Candle } from '../../types';

export class SymbolActor {
  private readonly store = new MultiTimeframeStore({ maxBars: 1000 });
  private readonly book = new LocalOrderBook();
  private readonly tape = new AggTradeTape(1000);
  private readonly strategies: StrategyModule[] = [];

  constructor(
    public readonly symbol: string,
    private readonly eventBus: EventBus
  ) {
    this.subscribe();
  }

  public addStrategy(strategy: StrategyModule): void {
    this.strategies.push(strategy);
  }

  private subscribe(): void {
    this.eventBus.subscribeAll((event: DomainEvent<any>) => {
      if (event.symbol !== this.symbol) return;

      switch (event.type) {
        case 'market.kline.closed':
          this.handleKline(event.payload);
          break;
        case 'market.trade':
          this.handleTrade(event.payload);
          break;
        case 'market.depth.delta':
          this.handleDepth(event.payload);
          break;
        case 'market.bookticker':
          this.handleBookTicker(event.payload);
          break;
      }
    });
  }

  private handleKline(payload: any): void {
    // Assuming tf is 1m for now, or we need tf in payload
    const candle: Candle = {
      openTime: payload.openTime,
      closeTime: payload.closeTime,
      open: payload.open,
      high: payload.high,
      low: payload.low,
      close: payload.close,
      volume: payload.volume,
    };
    
    // Default to 1m if not specified in event
    const tf = (payload as any).timeframe || '1m';
    this.store.applyKline(this.symbol, tf, candle, true);

    for (const strategy of this.strategies) {
      const result = strategy.onKline(candle);
      if (result) {
        this.emitResult(result);
      }
    }
  }

  private handleTrade(payload: any): void {
    this.tape.push({
      price: payload.price,
      qty: payload.quantity,
      ts: payload.timestamp,
      makerSide: payload.isBuyerMaker,
    });

    for (const strategy of this.strategies) {
      if (strategy.onTrade) {
        const result = strategy.onTrade(payload.price, payload.quantity, payload.isBuyerMaker);
        if (result) this.emitResult(result);
      }
    }
  }

  private handleDepth(payload: any): void {
    this.book.applyDiff({
      U: payload.firstUpdateId,
      u: payload.finalUpdateId,
      bids: payload.bids,
      asks: payload.asks,
      E: payload.timestamp,
    });

    for (const strategy of this.strategies) {
      if (strategy.onBookUpdate) {
        const bid = this.book.bestBid()?.price || 0;
        const ask = this.book.bestAsk()?.price || 0;
        const result = strategy.onBookUpdate(bid, ask);
        if (result) this.emitResult(result);
      }
    }
  }

  private handleBookTicker(payload: any): void {
    // Update local book if needed, or just notify strategies
    for (const strategy of this.strategies) {
      if (strategy.onBookUpdate) {
        const result = strategy.onBookUpdate(payload.bestBidPrice, payload.bestAskPrice);
        if (result) this.emitResult(result);
      }
    }
  }

  private emitResult(result: any): void {
    const type = (result as any).signal ? 'strategy.signal' : 'execution.order.requested';
    this.eventBus.publish({
      id: `res-${this.symbol}-${Date.now()}`,
      type,
      ts: Date.now(),
      source: `actor-${this.symbol}`,
      symbol: this.symbol,
      payload: result,
    });
  }
}
