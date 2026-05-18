import { EventBus } from '../events/event-bus';
import { DomainEvent, SignalPayload } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';

interface TrackedPosition {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
}

export interface SignalReversalOptions {
  /** Minimum confidence of the opposite signal to trigger an exit. */
  minConfidence: number;
}

/**
 * SignalReversalExitManager — closes positions when the strategy flips bias.
 * 
 * If we are LONG and a confident SHORT signal arrives, we close immediately 
 * instead of waiting for the trailing stop loss to be hit. This cuts losses 
 * earlier and preserves capital for the new trend.
 */
export class SignalReversalExitManager {
  private positions = new Map<string, TrackedPosition>();
  private seq = 0;
  private readonly opts: SignalReversalOptions;

  constructor(private readonly eventBus: EventBus, opts: Partial<SignalReversalOptions> = {}) {
    this.opts = { minConfidence: 0.5, ...opts };
    this.subscribe();
  }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => this.onFilled(e));
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => this.onClosed(e));
    this.eventBus.subscribe<SignalPayload>('strategy.signal', (e: DomainEvent<SignalPayload>) => this.onSignal(e));
  }

  private onFilled(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol: string | undefined = p?.symbol;
    if (!symbol) return;
    if (this.positions.has(symbol)) return;
    const side: 'LONG' | 'SHORT' = p?.side === 'SHORT' ? 'SHORT' : 'LONG';
    this.positions.set(symbol, { orderId: String(p?.orderId ?? ''), symbol, side });
  }

  private onClosed(event: DomainEvent<any>): void {
    const sym = event.payload?.symbol;
    if (event.payload?.reason === 'PARTIAL_TP') return;
    if (sym) this.positions.delete(sym);
  }

  private onSignal(event: DomainEvent<SignalPayload>): void {
    const symbol = event.symbol;
    if (!symbol) return;
    const pos = this.positions.get(symbol);
    if (!pos) return;

    const sig = event.payload;
    if (sig.confidence < this.opts.minConfidence) return;

    const isReversal = (pos.side === 'LONG' && sig.signal === 'SHORT') || 
                       (pos.side === 'SHORT' && sig.signal === 'LONG');

    if (!isReversal) return;

    this.positions.delete(symbol);
    this.seq += 1;
    const ts = marketClock.now();
    this.eventBus.publish({
      id: `sig-reversal-${symbol}-${ts}-${this.seq}`,
      type: 'execution.position.close.requested',
      ts,
      source: 'signal-reversal-exit-manager',
      symbol,
      payload: {
        symbol,
        orderId: pos.orderId,
        side: pos.side,
        reason: 'SIGNAL_REVERSAL',
        triggerPrice: 0, // Market close
        signalConfidence: sig.confidence,
      },
    });
  }
}
