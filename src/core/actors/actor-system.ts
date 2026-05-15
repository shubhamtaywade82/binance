import { EventBus } from '../events/event-bus';
import { SymbolActor } from './symbol-actor';
import { RiskEngine } from '../risk/risk-engine';
import { AppConfig } from '../../config';
import { SmcStrategyModule } from '../../strategy/smc-module';
import { SolMtfStrategyModule } from '../../strategy/sol-mtf-strategy-module';

export class ActorSystem {
  private actors = new Map<string, SymbolActor>();
  private riskEngine: RiskEngine;
  private readonly executionTf: string;

  constructor(
    cfg: AppConfig,
    private readonly eventBus: EventBus,
  ) {
    this.riskEngine = new RiskEngine(cfg, eventBus);
    this.executionTf = cfg.BINANCE_TIMEFRAMES?.[0] ?? '1m';
  }

  public getRiskEngine(): RiskEngine {
    return this.riskEngine;
  }

  public spawnSymbolActor(symbol: string): SymbolActor {
    const existing = this.actors.get(symbol);
    if (existing) return existing;

    const actor = new SymbolActor(symbol, this.eventBus, { executionTf: this.executionTf });
    this.attachDefaultStrategies(symbol, actor);
    this.actors.set(symbol, actor);
    return actor;
  }

  /**
   * Attach default strategies for a symbol. SOL gets the multi-TF module;
   * everything else gets SMC. Users can call `actor.addStrategy(...)` to extend.
   */
  private attachDefaultStrategies(symbol: string, actor: SymbolActor): void {
    if (symbol.toUpperCase().startsWith('SOL')) {
      actor.addStrategy((ctx) => new SolMtfStrategyModule(ctx));
    } else {
      actor.addStrategy((ctx) => new SmcStrategyModule(ctx));
    }
  }

  public getActor(symbol: string): SymbolActor | undefined {
    return this.actors.get(symbol);
  }

  public symbols(): string[] {
    return [...this.actors.keys()];
  }

  public shutdown(): void {
    this.actors.clear();
  }
}
