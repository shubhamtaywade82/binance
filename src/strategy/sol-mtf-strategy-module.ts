import { StrategyModule, StrategyContext } from '../core/strategy/strategy-module';
import { Candle } from '../types';
import { evaluateSolMtfStrategy, SolMtfTf } from './sol-mtf-strategy';
import { SignalPayload, OrderRequestedPayload } from '@coindcx/contracts';

export class SolMtfStrategyModule extends StrategyModule {
  constructor(ctx: StrategyContext) {
    super(ctx);
  }

  public getName(): string {
    return 'SolMtfStrategy';
  }

  public onKline(candle: Candle): SignalPayload | OrderRequestedPayload | null {
    const timeframes: SolMtfTf[] = ['1d', '4h', '1h', '15m', '5m'];
    const candlesRecord: Partial<Record<SolMtfTf, Candle[]>> = {};

    for (const tf of timeframes) {
      const history = this.ctx.getHistory(tf);
      if (history.length === 0) return null;
      candlesRecord[tf] = history;
    }

    const result = evaluateSolMtfStrategy({
      candles: candlesRecord as Record<SolMtfTf, Candle[]>,
      refPrice: candle.close,
      minConfidence: 0.65, // Should be from config
    });

    if (result.pass) {
      return {
        strategyId: this.getName(),
        signal: result.direction === 'LONG' ? 'LONG' : (result.direction === 'SHORT' ? 'SHORT' : 'FLAT'),
        confidence: 0.8,
        metadata: {
          reasons: result.reasons,
        }
      };
    }

    return null;
  }
}
