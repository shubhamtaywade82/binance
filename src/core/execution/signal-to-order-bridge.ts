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

    const now = marketClock.now();
    const key = this.cooldownKey(symbol, sig.signal, sig.strategyId);
    const last = this.lastEmit.get(key) ?? 0;
    if (now - last < this.cooldownMs) return;

    const price = this.priceProvider.lastPrice(symbol);
    if (!price || price <= 0) return;

    // Capital fallback chain so the bridge works without explicit config:
    //   1. CAPITAL_PER_TRADE_USDT (explicit per-trade size)
    //   2. 2% of PAPER_INITIAL_BALANCE_USDT (risk-based default → 200 on 10k)
    //   3. Hard floor of 50 USDT so paper trades are always attempted
    const explicitCapital = Number(this.cfg.CAPITAL_PER_TRADE_USDT);
    const paperEquity = Number((this.cfg as any).PAPER_INITIAL_BALANCE_USDT) || 10_000;
    const capitalUsdt = explicitCapital > 0 ? explicitCapital : Math.max(50, paperEquity * 0.02);
    const leverage = Number(this.cfg.LEVERAGE) || 1;

    // ── Trade Planning ────────────────────────────────────────────────────
    // TradePlanner runs only when the strategy has supplied an ATR value in
    // metadata. Strategies that emit bare signals (no metadata.atrValue) fall
    // back to the config flat-% sizing so backward compatibility is preserved.
    const meta = sig.metadata as Record<string, unknown> | undefined;
    const hasAtr = typeof meta?.atrValue === 'number' && (meta.atrValue as number) > 0;
    const regime = (meta?.regime as string | undefined) ?? 'UNKNOWN';
    const closeTime = typeof meta?.closeTime === 'number' ? meta.closeTime : 0;

    const plan = hasAtr
      ? computeTradePlan(
          {
            symbol,
            side: sig.signal as 'LONG' | 'SHORT',
            entryPrice: price,
            confidence: sig.confidence,
            regime,
            atrValue: meta!.atrValue as number,
          },
          this.plannerCfg,
        )
      : null;

    // When TradePlanner is active and the plan fails RR gate: soft reject.
    // (Bare signals without ATR always proceed to the legacy flat-% path.)
    if (hasAtr && !plan) {
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

    // ── OMS state advance ────────────────────────────────────────────────
    const m = this.oms.get(symbol);
    const tradeId = plan?.tradeId ?? `legacy-${symbol}-${now}`;
    m.transition('SIGNAL_CANDIDATE', 'signal_received', tradeId);
    m.transition('PLAN_READY', 'plan_computed', tradeId);

    const notional = capitalUsdt * leverage;
    const quantity = notional / price;
    if (quantity <= 0) return;

    // ── SL / TP resolution ───────────────────────────────────────────────
    const dir = sig.signal === 'LONG' ? 1 : -1;
    const tpPct = Number(this.cfg.TP_PRICE_PCT) || 0;
    const slPct = Number(this.cfg.SL_PRICE_PCT) || 0;
    const stopLoss = plan ? plan.stopLoss : (slPct > 0 ? price * (1 - dir * slPct) : undefined);
    const takeProfit = plan ? plan.targets[0]?.price : (tpPct > 0 ? price * (1 + dir * tpPct) : undefined);

    // Build TP ladder for TpLadderManager.
    const tpLadder = plan
      ? plan.targets.map((t) => ({ price: t.price, fraction: t.fraction }))
      : undefined;

    const atrValue = plan?.atr ?? (hasAtr ? (meta!.atrValue as number) : undefined);

    this.seq += 1;
    const payload: OrderRequestedPayload & Record<string, unknown> = {
      symbol,
      side: sig.signal as 'LONG' | 'SHORT',
      quantity,
      type: 'MARKET',
      price,
      takeProfit,
      stopLoss,
      strategyId: sig.strategyId,
      correlationId: event.id,
      // ── Extended fields consumed by downstream managers ──────────────────
      tpLadder,
      trailAfterLadder: plan ? true : undefined,
      regime,
      atrAtEntry: atrValue,
      // ── Allocator scoring ────────────────────────────────────────────────
      score: {
        adx: 0,
        atrPct: atrValue ? atrValue / price : 0,
        closeTime,
        qualityScore: plan?.qualityScore,
        rr: plan?.rr,
        regime,
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
