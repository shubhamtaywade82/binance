import { EventBus } from '../../core/events/event-bus';
import { MultiplexCallbacks } from '../../binance/ws-multiplex';

export class MarketEventPublisher {
  constructor(private readonly eventBus: EventBus) {}

  public getCallbacks(): Partial<MultiplexCallbacks> {
    return {
      onKline: (symbol, interval, candle, isFinal) => {
        if (isFinal) {
          this.eventBus.publish({
            id: `kline-${symbol}-${interval}-${candle.openTime}`,
            type: 'market.kline.closed',
            ts: Date.now(),
            source: 'binance-ws',
            symbol,
            payload: {
              openTime: candle.openTime,
              closeTime: candle.closeTime,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
              quoteVolume: (candle as any).quoteVolume ?? 0,
              trades: (candle as any).trades ?? 0,
            }
          });
        }
      },
      onAggTrade: (trade) => {
        this.eventBus.publish({
          id: `trade-${trade.symbol}-${trade.aggTradeId || trade.ts}`,
          type: 'market.trade',
          ts: trade.ts,
          source: 'binance-ws',
          symbol: trade.symbol,
          payload: {
            tradeId: trade.aggTradeId,
            price: trade.price,
            quantity: trade.qty,
            isBuyerMaker: trade.makerSide,
            timestamp: trade.ts,
          }
        });
      },
      onBookTicker: (ticker) => {
        this.eventBus.publish({
          id: `bookTicker-${ticker.symbol}-${ticker.updateId || ticker.ts}`,
          type: 'market.bookticker',
          ts: ticker.ts,
          source: 'binance-ws',
          symbol: ticker.symbol,
          payload: {
            updateId: ticker.updateId || 0,
            bestBidPrice: ticker.bestBid,
            bestBidQty: ticker.bestBidQty,
            bestAskPrice: ticker.bestAsk,
            bestAskQty: ticker.bestAskQty,
            timestamp: ticker.ts,
          }
        });
      },
      onDepthDiff: (diff) => {
        this.eventBus.publish({
          id: `depthDiff-${diff.s}-${diff.u}`,
          type: 'market.depth.delta',
          ts: diff.E || Date.now(),
          source: 'binance-ws',
          symbol: diff.s,
          payload: {
            firstUpdateId: diff.U,
            finalUpdateId: diff.u,
            bids: diff.bids.map(b => [parseFloat(String(b[0])), parseFloat(String(b[1]))]),
            asks: diff.asks.map(a => [parseFloat(String(a[0])), parseFloat(String(a[1]))]),
            timestamp: diff.E || Date.now(),
          }
        });
      }
    };
  }
}
