import { StrategyModule, StrategyContext } from '../core/strategy/strategy-module';
import { Candle } from '../types';
import { analyzeSmc } from './smc';
import { SignalPayload, OrderRequestedPayload } from '@coindcx/contracts';

export class SmcStrategyModule extends StrategyModule {
  private htfBias: 'LONG' | 'SHORT' | 'NONE' = 'NONE';

  constructor(ctx: StrategyContext) {
    super(ctx);
  }

  public getName(): string {
    return 'SmartMoneyConcepts';
  }

  public setHtfBias(bias: 'LONG' | 'SHORT' | 'NONE'): void {
    this.htfBias = bias;
  }

  public onKline(candle: Candle): SignalPayload | OrderRequestedPayload | null {
    const history = this.ctx.getHistory();
    if (history.length < 50) return null;

    const analysis = analyzeSmc(history, candle.close, this.htfBias);
    
    // Convert SMC analysis to a signal if conditions met
    if (analysis.score >= 3) {
      return {
        strategyId: this.getName(),
        signal: this.htfBias === 'LONG' ? 'LONG' : (this.htfBias === 'SHORT' ? 'SHORT' : 'FLAT'),
        confidence: analysis.score / 5,
        metadata: {
          score: analysis.score,
          trend: analysis.trend,
        }
      };
    }

    return null;
  }
}
