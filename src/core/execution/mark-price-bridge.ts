import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { ExecutionAdapter } from '../../execution/types';

/**
 * MarkPriceBridge — forwards `market.mark` events into the execution
 * adapter's onMark hook. PaperExecutionAdapter uses this for:
 *   • unrealized PnL recalculation across every open position
 *   • liquidation triggers
 *   • equity snapshots written to ledger + Postgres
 *
 * Live adapters ignore onMark; the bridge is a no-op for them.
 */
export class MarkPriceBridge {
  constructor(
    private readonly eventBus: EventBus,
    private readonly adapter: ExecutionAdapter,
  ) {
    this.eventBus.subscribe('market.mark', (e: DomainEvent<any>) => {
      const sym = e.symbol;
      const mark = Number(e.payload?.markPrice);
      if (!sym || !Number.isFinite(mark)) return;
      this.adapter.onMark?.(sym, mark);
    });
    // Fallback: when no markPrice stream (e.g. spot), use bookticker mid.
    this.eventBus.subscribe('market.bookticker', (e: DomainEvent<any>) => {
      const sym = e.symbol;
      const bid = Number(e.payload?.bestBidPrice);
      const ask = Number(e.payload?.bestAskPrice);
      if (!sym || !Number.isFinite(bid) || !Number.isFinite(ask)) return;
      this.adapter.onMark?.(sym, (bid + ask) / 2);
    });
  }
}
