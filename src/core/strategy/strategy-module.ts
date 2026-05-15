import { Candle } from '../../types';
import { SignalPayload, OrderRequestedPayload } from '@coindcx/contracts';

export interface StrategyContext {
  symbol: string;
  timeframe: string;
  getHistory(timeframe?: string): Candle[];
}

export abstract class StrategyModule {
  constructor(protected readonly ctx: StrategyContext) {}

  public abstract getName(): string;

  /**
   * Called when a new candle is closed.
   * Return a signal if the strategy wants to trigger an action.
   */
  public abstract onKline(candle: Candle): SignalPayload | OrderRequestedPayload | null;

  /**
   * Optional: Called on every trade for high-frequency strategies.
   */
  public onTrade?(price: number, qty: number, side: boolean): SignalPayload | OrderRequestedPayload | null;

  /**
   * Optional: Called on order book updates.
   */
  public onBookUpdate?(bestBid: number, bestAsk: number): SignalPayload | OrderRequestedPayload | null;
}
