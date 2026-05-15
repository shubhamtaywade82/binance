import { EventBus } from '../events/event-bus';
import {
  DomainEvent,
  OrderValidatedPayload,
  OrderRequestedPayload,
} from '@coindcx/contracts';
import { ExecutionAdapter, OrderRequest } from '../../execution/types';
import { AppConfig } from '../../config';
import { marketClock } from '../time/market-clock';

/**
 * ExecutionBridge — subscribes to `execution.order.accepted` (emitted by
 * RiskEngine after validating a request) and forwards to the configured
 * `ExecutionAdapter` (paper / Binance / CoinDCX). Emits:
 *   execution.order.submitted   on successful adapter call
 *   execution.order.filled      with fill price + fees
 *   execution.order.rejected    on adapter error
 *
 * This is the SOLE consumer of order.accepted — keeps live/paper parity
 * because both routes go through identical event chain.
 */
export class ExecutionBridge {
  private seq = 0;

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly adapter: ExecutionAdapter,
  ) {
    this.subscribe();
  }

  private subscribe(): void {
    this.eventBus.subscribe<OrderValidatedPayload>('execution.order.accepted', (e) => {
      void this.handleAccepted(e);
    });
  }

  private async handleAccepted(event: DomainEvent<OrderValidatedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.symbol || !p.price) return;

    const req: OrderRequest = {
      pair: p.symbol,
      side: p.side,
      quantity: p.quantity,
      leverage: Number(this.cfg.LEVERAGE) || 1,
      marginCurrency: 'USDT',
      referencePrice: p.price,
      takeProfit: p.takeProfit,
      stopLoss: p.stopLoss,
    };

    this.seq += 1;
    const submittedTs = marketClock.now();
    this.eventBus.publish({
      id: `order-sub-${p.symbol}-${submittedTs}-${this.seq}`,
      type: 'execution.order.submitted',
      ts: submittedTs,
      source: `execution:${this.adapter.name}`,
      symbol: p.symbol,
      payload: {
        orderId: `pending-${submittedTs}-${this.seq}`,
        symbol: p.symbol,
        side: p.side === 'LONG' ? 'BUY' : 'SELL',
        type: p.type,
        quantity: p.quantity,
        price: p.price,
        strategyId: p.strategyId,
      },
    });

    try {
      const result = await this.adapter.placeOrder(req);
      const ts = marketClock.now();
      if (result.ok) {
        this.eventBus.publish({
          id: `order-fill-${result.orderId}`,
          type: 'execution.order.filled',
          ts,
          source: `execution:${this.adapter.name}`,
          symbol: p.symbol,
          payload: {
            orderId: result.orderId,
            symbol: p.symbol,
            side: p.side,
            quantity: result.fill.quantity,
            price: result.fill.price,
            feeUsdt: result.fill.feeUsdt,
            slippageUsdt: result.fill.slippageUsdt,
            latencyMs: result.fill.latencyMs,
            strategyId: p.strategyId,
            correlationId: p.correlationId,
          },
        });
      } else {
        this.publishRejected(p, result.error ?? 'ADAPTER_FAILURE', ts);
      }
    } catch (err) {
      this.publishRejected(p, (err as Error).message || 'ADAPTER_THREW', marketClock.now());
    }
  }

  private publishRejected(p: OrderRequestedPayload | OrderValidatedPayload, reason: string, ts: number): void {
    this.eventBus.publish({
      id: `order-rej-${p.symbol}-${ts}-${this.seq}`,
      type: 'execution.order.rejected',
      ts,
      source: `execution:${this.adapter.name}`,
      symbol: p.symbol,
      payload: { reason, requested: p },
    });
  }
}
