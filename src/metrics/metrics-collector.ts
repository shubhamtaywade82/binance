import { TradingMetrics, TradingMetricsTracker } from './trading-metrics';
import { ModelMetricsSnapshot, ModelMetricsTracker } from './model-metrics';
import { SystemMetricsSnapshot, SystemMetricsTracker } from './system-metrics';

export class MetricsCollector {
  readonly trading: TradingMetricsTracker;
  readonly model: ModelMetricsTracker;
  readonly system: SystemMetricsTracker;

  constructor(initialEquity?: number) {
    this.trading = new TradingMetricsTracker(initialEquity);
    this.model = new ModelMetricsTracker();
    this.system = new SystemMetricsTracker();
  }

  fullSnapshot(): {
    trading: TradingMetrics;
    model: ModelMetricsSnapshot;
    system: SystemMetricsSnapshot;
  } {
    return {
      trading: this.trading.snapshot(),
      model: this.model.snapshot(),
      system: this.system.snapshot(),
    };
  }
}
