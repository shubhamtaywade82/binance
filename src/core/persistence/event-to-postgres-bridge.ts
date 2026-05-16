import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { PgWriter } from '../../persistence/pg-writer';
import { AppConfig } from '../../config';
import { marketClock } from '../time/market-clock';

/**
 * EventToPostgresBridge — projects event-bus fills/closes into the relational
 * PnL tables. Without this, only the legacy PositionManager path populates
 * `positions` / `trades` / `orders`, so the PnL dashboard would not see any
 * trades placed via the new actor → RiskEngine → ExecutionBridge chain.
 *
 * Subscribes:
 *   execution.order.submitted    → orders row (status=SUBMITTED)
 *   execution.order.filled       → upsert position + orders row (status=FILLED)
 *   execution.position.closed    → write trade + remove position
 *   execution.order.rejected     → orders row (status=REJECTED)
 */
export class EventToPostgresBridge {
  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly pg: PgWriter,
  ) {
    if (!pg.isConnected) {
      // Bridge is still subscribed so that if the pool reconnects later the
      // events will land. pgWriter methods themselves no-op when pool=null.
    }
    this.subscribe();
  }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.submitted', (e: DomainEvent<any>) =>
      this.writeOrder(e, 'SUBMITTED'),
    );
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => {
      this.writeOrder(e, 'FILLED');
      this.upsertPositionFromFill(e);
    });
    this.eventBus.subscribe('execution.order.rejected', (e: DomainEvent<any>) =>
      this.writeOrder(e, 'REJECTED'),
    );
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) =>
      this.onPositionClosed(e),
    );
  }

  private writeOrder(event: DomainEvent<any>, status: string): void {
    const p = event.payload;
    const symbol = (p?.symbol ?? event.symbol) as string | undefined;
    if (!symbol) return;
    const orderId = String(p?.orderId ?? `${event.id}`);
    const qty = Number(p?.quantity) || 0;
    const price = Number(p?.price ?? p?.requested?.price) || 0;
    void this.pg.writeOrder({
      orderId,
      symbol,
      side: this.normalizeSide(p?.side ?? p?.requested?.side),
      quantity: qty,
      price,
      status,
      fillPrice: status === 'FILLED' ? price : undefined,
      feeUsdt: status === 'FILLED' ? Number(p?.feeUsdt) || 0 : undefined,
      slippageUsdt: status === 'FILLED' ? Number(p?.slippageUsdt) || 0 : undefined,
      latencyMs: Number(p?.latencyMs) || undefined,
    });
  }

  private upsertPositionFromFill(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol = (p?.symbol ?? event.symbol) as string | undefined;
    if (!symbol) return;
    const side = this.normalizeSide(p?.side);
    const quantity = Number(p?.quantity) || 0;
    const entryPrice = Number(p?.price) || 0;
    if (quantity <= 0 || entryPrice <= 0) return;
    const leverage = Number(p?.leverage) || Number(this.cfg.LEVERAGE) || 1;
    const notional = quantity * entryPrice;
    const marginUsdt = notional / leverage;

    void this.pg.upsertPosition({
      orderId: String(p?.orderId ?? event.id),
      symbol,
      side,
      quantity,
      entryPrice,
      leverage,
      marginUsdt,
      liqPrice: Number(p?.liqPrice) || 0,
      openedAt: marketClock.now(),
      unrealizedPnl: 0,
    });
  }

  private onPositionClosed(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol = (p?.symbol ?? event.symbol) as string | undefined;
    const orderId = String(p?.orderId ?? '');
    if (!symbol || !orderId) return;

    void this.pg.writeTrade(
      {
        orderId,
        side: this.normalizeSide(p?.side),
        leverage: Number(p?.leverage) || Number(this.cfg.LEVERAGE) || 1,
        entryPrice: Number(p?.entryPrice) || 0,
        exitPrice: Number(p?.exitPrice) || 0,
        quantity: Number(p?.quantity) || 0,
        reason: (p?.reason as any) || 'MANUAL',
        grossUsdt: Number(p?.grossUsdt) || 0,
        feesUsdt: Number(p?.feesUsdt) || 0,
        fundingUsdt: Number(p?.fundingUsdt) || 0,
        netUsdt: Number(p?.netUsdt) || 0,
        openedAt: Number(p?.openedAt) || 0,
        closedAt: Number(p?.closedAt) || marketClock.now(),
      },
      symbol,
    );
    void this.pg.removePosition(orderId);
  }

  private normalizeSide(s: unknown): 'LONG' | 'SHORT' {
    return s === 'SHORT' || s === 'SELL' ? 'SHORT' : 'LONG';
  }
}
