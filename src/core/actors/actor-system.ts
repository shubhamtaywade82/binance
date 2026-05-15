import { EventBus } from '../events/event-bus';
import { SymbolActor } from './symbol-actor';
import { RiskEngine } from '../risk/risk-engine';
import { AppConfig } from '../../config';
import { SmcStrategyModule } from '../../strategy/smc-module';
import { SolMtfStrategyModule } from '../../strategy/sol-mtf-strategy-module';
import { SeykotaTrendModule } from '../../strategy/seykota-module';

export class ActorSystem {
  private actors = new Map<string, SymbolActor>();
  private riskEngine: RiskEngine;
  private readonly executionTf: string;
  private readonly cfg: AppConfig;

  constructor(
    cfg: AppConfig,
    private readonly eventBus: EventBus,
  ) {
    this.cfg = cfg;
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
    const cfg = this.cfg as any;
    if (cfg.SEYKOTA_ENABLED) {
      actor.addStrategy((ctx) => new SeykotaTrendModule(ctx, {
        htf: cfg.SEYKOTA_HTF,
        fastEma: cfg.SEYKOTA_FAST_EMA,
        slowEma: cfg.SEYKOTA_SLOW_EMA,
        adxPeriod: cfg.SEYKOTA_ADX_PERIOD,
        adxThreshold: cfg.SEYKOTA_ADX_THRESHOLD,
        atrPeriod: cfg.SEYKOTA_ATR_PERIOD,
        atrMult: cfg.SEYKOTA_ATR_MULT,
        minAtrPct: cfg.SEYKOTA_MIN_ATR_PCT,
        riskPct: cfg.SEYKOTA_RISK_PCT,
        equityUsdt: cfg.SEYKOTA_EQUITY_USDT,
        minBars: cfg.SEYKOTA_MIN_BARS,
      }));
      return;
    }
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
