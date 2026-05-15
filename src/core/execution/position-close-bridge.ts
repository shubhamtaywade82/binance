import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { ExecutionAdapter, CloseReason } from '../../execution/types';
import { marketClock } from '../time/market-clock';

/**
 * PositionCloseBridge — subscribes execution.position.close.requested and
 * calls adapter.closePosition. Emits execution.position.closed which feeds
 * the RiskEngine exposure release.
 *
 * Idempotency: tracks in-flight orderIds so a duplicate close request from
 * the trailing stop + a manual operator close don't double-fire.
 */
export class PositionCloseBridge {
  private inFlight = new Set<string>();
  private seq = 0;

  constructor(
    private readonly eventBus: EventBus,
    private readonly adapter: ExecutionAdapter,
  ) {
    this.eventBus.subscribe('execution.position.close.requested', (e: DomainEvent<any>) =>
      void this.handle(e),
    );
  }

  private async handle(event: DomainEvent<any>): Promise<void> {
    const p = event.payload;
    const orderId: string | undefined = p?.orderId;
    const symbol: string | undefined = p?.symbol ?? event.symbol;
    if (!orderId || !symbol) return;
    if (this.inFlight.has(orderId)) return;
    this.inFlight.add(orderId);

    const reason: CloseReason = (p?.reason as CloseReason) ?? 'MANUAL';
    try {
      const closed = await this.adapter.closePosition(orderId, reason);
      this.seq += 1;
      this.eventBus.publish({
        id: `pos-closed-${orderId}-${this.seq}`,
        type: 'execution.position.closed',
        ts: marketClock.now(),
        source: `execution:${this.adapter.name}`,
        symbol,
        payload: {
          symbol,
          orderId,
          side: closed.side,
          entryPrice: closed.entryPrice,
          exitPrice: closed.exitPrice,
          quantity: closed.quantity,
          reason: closed.reason,
          grossUsdt: closed.grossUsdt,
          feesUsdt: closed.feesUsdt,
          fundingUsdt: closed.fundingUsdt,
          netUsdt: closed.netUsdt,
          openedAt: closed.openedAt,
          closedAt: closed.closedAt,
        },
      });
    } catch (err) {
      this.seq += 1;
      this.eventBus.publish({
        id: `pos-close-fail-${orderId}-${this.seq}`,
        type: 'execution.position.close.failed',
        ts: marketClock.now(),
        source: `execution:${this.adapter.name}`,
        symbol,
        payload: { orderId, symbol, reason: (err as Error).message },
      });
    } finally {
      this.inFlight.delete(orderId);
    }
  }
}
