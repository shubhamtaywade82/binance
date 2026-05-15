import { EventBus } from '../events/event-bus';
import { DomainEvent, OrderRequestedPayload, OrderValidatedPayload } from '@coindcx/contracts';
import { AppConfig } from '../../config';

export class RiskEngine {
  private totalNotionalUsdt = 0;
  private openPositions = new Map<string, number>(); // symbol -> notional

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus
  ) {
    this.subscribe();
  }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.requested', (event: DomainEvent<OrderRequestedPayload>) => {
      this.validateOrder(event.payload);
    });

    // We also need to track filled orders to update our exposure
    this.eventBus.subscribe('execution.order.filled', (event: DomainEvent<any>) => {
      this.updateExposure(event.payload);
    });
  }

  private validateOrder(payload: OrderRequestedPayload): void {
    const { symbol, quantity, price } = payload;
    
    // 1. Check max total exposure
    const orderNotional = quantity * (price || 0);
    if (this.totalNotionalUsdt + orderNotional > (this.cfg as any).MAX_TOTAL_EXPOSURE_USDT) {
      this.rejectOrder(payload, 'MAX_TOTAL_EXPOSURE_EXCEEDED');
      return;
    }

    // 2. Check max symbols
    if (!this.openPositions.has(symbol) && this.openPositions.size >= (this.cfg as any).MAX_OPEN_SYMBOLS) {
      this.rejectOrder(payload, 'MAX_OPEN_SYMBOLS_EXCEEDED');
      return;
    }

    // 3. Correlation check (placeholder for now)
    
    // If all checks pass, emit validated event
    const validated: OrderValidatedPayload = {
      ...payload,
      riskMetrics: {
        currentTotalNotional: this.totalNotionalUsdt,
        orderNotional,
      }
    };

    this.eventBus.publish({
      id: `val-${symbol}-${Date.now()}`,
      type: 'execution.order.accepted',
      ts: Date.now(),
      source: 'risk-engine',
      symbol,
      payload: validated,
    });
  }

  private updateExposure(_payload: any): void {
    // Logic to update this.totalNotionalUsdt and this.openPositions
    // based on fills. For now, this is a simplified stub.
  }

  private rejectOrder(payload: OrderRequestedPayload, reason: string): void {
    this.eventBus.publish({
      id: `rej-${payload.symbol}-${Date.now()}`,
      type: 'execution.order.rejected',
      ts: Date.now(),
      source: 'risk-engine',
      symbol: payload.symbol,
      payload: {
        reason,
        requested: payload,
      }
    });
    console.warn(`[RiskEngine] Order rejected: ${reason}`, payload);
  }
}
