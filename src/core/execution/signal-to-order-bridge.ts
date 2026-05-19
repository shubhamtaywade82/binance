import { EventBus } from '../events/event-bus';
import {
  DomainEvent,
  SignalPayload,
  OrderRequestedPayload,
} from '@coindcx/contracts';
import { AppConfig } from '../../config';
import { marketClock } from '../time/market-clock';
import { computeTradePlan, type TradePlannerConfig } from '../planning/trade-planner';
import { OrderStateRegistry } from '../oms/order-state-machine';

interface LastPriceProvider {
  lastPrice(symbol: string): number | null;
}

/**
 * SignalToOrderBridge — converts `strategy.signal` events into
 * `execution.order.requested` events.
 *
 * Upgrades over the original flat-% version:
 *  1. Calls TradePlanner to compute ATR-based SL, TP ladder, and RR.
 *  2. Drops signals where RR < minimum (soft reject before RiskEngine).
 *  3. Checks OrderStateRegistry so one symbol can't hold multiple concurrent
 *     order intents.
 *  4. Passes the full TP ladder in the payload for TpLadderManager.
 *  5. Passes qualityScore for the SignalAllocator best-of-bar ranking.
 */
export class SignalToOrderBridge {
  private seq = 0;
  private readonly cooldownMs: number;
  /**
   * H-4: cooldown key is `(symbol, side, strategyId)` so two strategies on
   * the same symbol don't share a cooldown bucket, and a flip from LONG to
   * SHORT on the same symbol isn't suppressed by a prior LONG signal still
   * inside the cooldown window.
   */
  private readonly lastEmit = new Map<string, number>();
  private readonly oms: OrderStateRegistry;
  private readonly plannerCfg: Partial<TradePlannerConfig>;

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly priceProvider: LastPriceProvider,
    opts: {
      cooldownMs?: number;
      oms?: OrderStateRegistry;
      plannerCfg?: Partial<TradePlannerConfig>;
    } = {},
  ) {
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.oms = opts.oms ?? new OrderStateRegistry(eventBus);
    this.plannerCfg = opts.plannerCfg ?? {};
    this.subscribe();
  }

  private cooldownKey(symbol: string, side: string, strategyId?: string): string {
    return `${symbol}|${side}|${strategyId ?? ''}`;
  }

  private subscribe(): void {
    this.eventBus.subscribe<SignalPayload>('strategy.signal', (event) => {
      this.handleSignal(event);
    });
  }

  private handleSignal(event: DomainEvent<SignalPayload>): void {
    const { symbol } = event;
    const sig = event.payload;
    if (!symbol || sig.signal === 'FLAT') return;
    if (sig.confidence < ((this.cfg as any).MIN_SIGNAL_CONFIDENCE ?? 0.5)) return;

    // OMS gate: block new intents while this symbol is already in-flight.
    if (!this.oms.get(symbol).isAvailable()) return;

    const now = marketClock.now();
    const key = this.cooldownKey(symbol, sig.signal, sig.strategyId);
    const last = this.lastEmit.get(key) ?? 0;
    if (now - last < this.cooldownMs) return;

    const price = this.priceProvider.lastPrice(symbol);
    if (!price || price <= 0) return;

    const capitalUsdt = Number(this.cfg.CAPITAL_PER_TRADE_USDT) || 0;
    if (capitalUsdt <= 0) return;
    const leverage = Number(this.cfg.LEVERAGE) || 1;

    // ── Trade Planning ────────────────────────────────────────────────────
    const meta = sig.metadata as Record<string, unknown> | undefined;
    const plan = computeTradePlan(
      {
        symbol,
        side: sig.signal as 'LONG' | 'SHORT',
        entryPrice: price,
        confidence: sig.confidence,
        regime: (meta?.regime as string | undefined) ?? 'UNKNOWN',
        atrValue: typeof meta?.atrValue === 'number' ? meta.atrValue : undefined,
      },
      this.plannerCfg,
    );

    // Soft reject: plan did not meet RR minimum or could not be computed.
    if (!plan) {
      this.eventBus.publish({
        id: `plan-reject-${symbol}-${now}`,
        type: 'execution.order.rejected',
        ts: now,
        source: 'signal-to-order-bridge',
        symbol,
        payload: { reason: 'PLAN_RR_BELOW_MINIMUM', requested: { symbol, side: sig.signal } },
      });
      return;
    }

    // Advance OMS to SIGNAL_CANDIDATE then PLAN_READY atomically.
    const m = this.oms.get(symbol);
    m.transition('SIGNAL_CANDIDATE', 'signal_received', plan.tradeId);
    m.transition('PLAN_READY', 'plan_computed', plan.tradeId);

    const notional = capitalUsdt * leverage;
    const quantity = notional / price;
    if (quantity <= 0) return;

    // Build TP ladder for TpLadderManager (absolute prices + fractions).
    const tpLadder = plan.targets.map((t) => ({
      price: t.price,
      fraction: t.fraction,
    }));

    this.seq += 1;
    const closeTime = typeof meta?.closeTime === 'number' ? meta.closeTime : 0;
    const payload: OrderRequestedPayload & Record<string, unknown> = {
      symbol,
      side: sig.signal as 'LONG' | 'SHORT',
      quantity,
      type: 'MARKET',
      price,
      takeProfit: plan.targets[0]?.price,
      stopLoss: plan.stopLoss,
      strategyId: sig.strategyId,
      correlationId: event.id,
      // ── Extended fields consumed by downstream managers ──────────────────
      tpLadder,
      trailAfterLadder: true,
      regime: plan.regime,
      atrAtEntry: plan.atr,
      // ── Allocator scoring ────────────────────────────────────────────────
      score: {
        adx: 0,          // legacy field kept for schema compat; allocator prefers qualityScore
        atrPct: plan.atr / price,
        closeTime,
        qualityScore: plan.qualityScore,
        rr: plan.rr,
        regime: plan.regime,
      },
    };

    this.eventBus.publish({
      id: `order-req-${symbol}-${now}-${this.seq}`,
      type: 'execution.order.requested',
      ts: now,
      source: 'signal-to-order-bridge',
      symbol,
      payload,
    });

    this.lastEmit.set(key, now);
  }
}
