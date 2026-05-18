import { EventBus } from '../events/event-bus';
import { SymbolActor } from './symbol-actor';
import { RiskEngine } from '../risk/risk-engine';
import { AppConfig } from '../../config';
import { SmcStrategyModule } from '../../strategy/smc-module';
import { AdaptiveStrategy } from '../../strategy/adaptive-strategy';
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
    if (cfg.ADAPTIVE_STRATEGY_ENABLED) {
      let modeOverrides: any = undefined;
      if (typeof cfg.ADAPTIVE_MODE_OVERRIDES_JSON === 'string' && cfg.ADAPTIVE_MODE_OVERRIDES_JSON.trim()) {
        try { modeOverrides = JSON.parse(cfg.ADAPTIVE_MODE_OVERRIDES_JSON); } catch { /* ignore */ }
      }
      actor.addStrategy((ctx) => new AdaptiveStrategy(ctx, {
        htf: cfg.SEYKOTA_HTF || '1h',
        equityUsdt: Number(cfg.ADAPTIVE_EQUITY_USDT) || Number(cfg.PAPER_INITIAL_BALANCE_USDT) || 10_000,
        atrPeriod: Number(cfg.SEYKOTA_ATR_PERIOD) || 14,
        minBars: Number(cfg.SEYKOTA_MIN_BARS) || 80,
        cooldownMs: Number(cfg.ADAPTIVE_COOLDOWN_MS) || 5 * 60_000,
        modeOverrides,
      }));
      return;
    }
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
        pyramidMaxAdds: cfg.SEYKOTA_PYRAMID_MAX_ADDS,
        pyramidRDistance: cfg.SEYKOTA_PYRAMID_R_DISTANCE,
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
    // M-4: detach each actor's per-type subscriptions so the EventBus
    // doesn't keep them alive past shutdown.
    for (const actor of this.actors.values()) actor.dispose();
    this.actors.clear();
  }
}
