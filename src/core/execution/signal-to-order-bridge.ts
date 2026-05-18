import { EventBus } from '../events/event-bus';
import {
  DomainEvent,
  SignalPayload,
  OrderRequestedPayload,
} from '@coindcx/contracts';
import { AppConfig } from '../../config';
import { marketClock } from '../time/market-clock';

interface LastPriceProvider {
  lastPrice(symbol: string): number | null;
}

/**
 * SignalToOrderBridge — converts `strategy.signal` events into
 * `execution.order.requested` events. Applies basic sizing from config
 * (USDT notional / last price / leverage), attaches TP / SL.
 *
 * The bridge runs OUT-OF-LOOP from the actor: the actor publishes the signal,
 * the bridge picks it up, the risk engine validates the resulting order. This
 * decoupling lets strategies stay pure (no sizing logic).
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

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly priceProvider: LastPriceProvider,
    opts: { cooldownMs?: number } = {},
  ) {
    this.cooldownMs = opts.cooldownMs ?? 60_000;
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

    const capitalUsdt = Number(this.cfg.CAPITAL_PER_TRADE_USDT) || 0;
    if (capitalUsdt <= 0) return;
    const leverage = Number(this.cfg.LEVERAGE) || 1;
    const notional = capitalUsdt * leverage;
    const quantity = notional / price;
    if (quantity <= 0) return;

    const tpPct = Number(this.cfg.TP_PRICE_PCT) || 0;
    const slPct = Number(this.cfg.SL_PRICE_PCT) || 0;
    const dir = sig.signal === 'LONG' ? 1 : -1;
    const takeProfit = tpPct > 0 ? price * (1 + dir * tpPct) : undefined;
    const stopLoss = slPct > 0 ? price * (1 - dir * slPct) : undefined;

    this.seq += 1;
    const payload: OrderRequestedPayload = {
      symbol,
      side: sig.signal,
      quantity,
      type: 'MARKET',
      price,
      takeProfit,
      stopLoss,
      strategyId: sig.strategyId,
      correlationId: event.id,
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
