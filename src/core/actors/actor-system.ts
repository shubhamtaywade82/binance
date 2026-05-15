import { EventBus } from '../events/event-bus';
import { SymbolActor } from './symbol-actor';
import { RiskEngine } from '../risk/risk-engine';
import { AppConfig } from '../../config';

export class ActorSystem {
  private actors = new Map<string, SymbolActor>();
  private riskEngine: RiskEngine;

  constructor(
    _cfg: AppConfig,
    private readonly eventBus: EventBus
  ) {
    this.riskEngine = new RiskEngine(_cfg, eventBus);
  }

  public getRiskEngine(): RiskEngine {
    return this.riskEngine;
  }

  public spawnSymbolActor(symbol: string): SymbolActor {
    if (this.actors.has(symbol)) {
      return this.actors.get(symbol)!;
    }

    const actor = new SymbolActor(symbol, this.eventBus);
    this.actors.set(symbol, actor);
    return actor;
  }

  public getActor(symbol: string): SymbolActor | undefined {
    return this.actors.get(symbol);
  }

  public shutdown(): void {
    this.actors.clear();
  }
}
