import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';

interface TrackedPosition {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entry: number;
  barsElapsed: number;
}

export interface TimeStopOptions {
  /** Force close after this many execution-TF bars if PnL still ≤ 0. */
  barsThreshold: number;
}

/**
 * TimeStopManager — closes positions that have gone nowhere.
 *
 * Trend-followers bleed equity holding losers; even a small adverse drift
 * eats funding + opportunity cost. Rule: if position open ≥ N bars and net
 * unrealized ≤ 0 → close (reason=TIME_STOP).
 *
 * Bars counted from kline.closed events on the position symbol; assumes the
 * actor's execution TF.
 */
export class TimeStopManager {
  private positions = new Map<string, TrackedPosition>();
  private seq = 0;
  private readonly opts: TimeStopOptions;

  constructor(private readonly eventBus: EventBus, opts: TimeStopOptions) {
    this.opts = opts;
    this.subscribe();
  }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => this.onFilled(e));
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => this.onClosed(e));
    this.eventBus.subscribe('market.kline.closed', (e: DomainEvent<any>) => this.onKline(e));
  }

  private onFilled(event: DomainEvent<any>): void {
    const p = event.payload;
    const symbol: string | undefined = p?.symbol;
    if (!symbol) return;
    if (this.positions.has(symbol)) return;
    const side: 'LONG' | 'SHORT' = p?.side === 'SHORT' ? 'SHORT' : 'LONG';
    const entry = Number(p?.price) || 0;
    if (entry <= 0) return;
    this.positions.set(symbol, { orderId: String(p?.orderId ?? ''), symbol, side, entry, barsElapsed: 0 });
  }

  private onClosed(event: DomainEvent<any>): void {
    const sym = event.payload?.symbol;
    if (sym) this.positions.delete(sym);
  }

  private onKline(event: DomainEvent<any>): void {
    const symbol = event.symbol;
    if (!symbol) return;
    const pos = this.positions.get(symbol);
    if (!pos) return;
    pos.barsElapsed += 1;

    if (pos.barsElapsed < this.opts.barsThreshold) return;

    const close = Number(event.payload?.close);
    if (!Number.isFinite(close)) return;

    const adverse = pos.side === 'LONG' ? close <= pos.entry : close >= pos.entry;
    if (!adverse) return; // give winners more time

    this.positions.delete(symbol);
    this.seq += 1;
    const ts = marketClock.now();
    this.eventBus.publish({
      id: `time-stop-${symbol}-${ts}-${this.seq}`,
      type: 'execution.position.close.requested',
      ts,
      source: 'time-stop-manager',
      symbol,
      payload: {
        symbol,
        orderId: pos.orderId,
        side: pos.side,
        reason: 'TIME_STOP',
        triggerPrice: close,
        barsElapsed: pos.barsElapsed,
      },
    });
  }
}
