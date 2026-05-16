import { EventBus } from '../events/event-bus';
import { DomainEvent } from '@coindcx/contracts';
import { marketClock } from '../time/market-clock';
import type { FundingEngine } from '../../execution/paper/funding';

interface TrackedPosition {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
}

export interface FundingExitOptions {
  /**
   * Annualized threshold in basis points. With 8h funding cadence, a single
   * funding event of 25 bps = 0.0025 → annualized ≈ 2738 bps. Default 50 bps
   * (single-tick) flags any adverse rate of meaningful size.
   *
   * The check uses |rate * 10000| (per-tick bps) compared to this threshold,
   * applied only to the side that pays.
   */
  perTickThresholdBps: number;
  /** Seconds before the next funding tick to evaluate / act. */
  preTickWindowSec: number;
  /** Poll interval (ms). */
  pollMs: number;
}

const DEFAULTS: FundingExitOptions = { perTickThresholdBps: 50, preTickWindowSec: 60, pollMs: 30_000 };

/**
 * FundingExitManager — closes positions just before an adverse funding tick.
 *
 *   LONG  pays funding when rate > 0  (longs pay shorts)
 *   SHORT pays funding when rate < 0
 *
 * If |rate| in bps exceeds the threshold AND the position's side is the payer
 * AND next funding time is within `preTickWindowSec`, request close
 * (reason=FUNDING_KICK). Position can be re-entered on the next signal after
 * funding settles.
 *
 * Funding rates come from the existing FundingEngine in the paper adapter.
 */
export class FundingExitManager {
  private positions = new Map<string, TrackedPosition>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private readonly opts: FundingExitOptions;

  constructor(
    private readonly eventBus: EventBus,
    private readonly funding: FundingEngine,
    opts: Partial<FundingExitOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.subscribe();
    this.timer = setInterval(() => this.tick(), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private subscribe(): void {
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => {
      const p = e.payload;
      const symbol: string | undefined = p?.symbol;
      if (!symbol) return;
      if (this.positions.has(symbol)) return;
      const side: 'LONG' | 'SHORT' = p?.side === 'SHORT' ? 'SHORT' : 'LONG';
      this.positions.set(symbol, { orderId: String(p?.orderId ?? ''), symbol, side });
    });
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
      const sym = e.payload?.symbol;
      if (sym) this.positions.delete(sym);
    });
  }

  private tick(): void {
    const now = marketClock.now();
    for (const pos of this.positions.values()) {
      const f = this.funding.getRate(pos.symbol);
      if (!f) continue;
      const secsToFunding = (f.nextTime - now) / 1000;
      if (secsToFunding > this.opts.preTickWindowSec || secsToFunding < 0) continue;
      const rateBps = f.rate * 10_000;
      const payerIsLong = f.rate > 0;
      const payerIsShort = f.rate < 0;
      const adverse = (pos.side === 'LONG' && payerIsLong) || (pos.side === 'SHORT' && payerIsShort);
      if (!adverse) continue;
      if (Math.abs(rateBps) < this.opts.perTickThresholdBps) continue;

      this.positions.delete(pos.symbol);
      this.seq += 1;
      this.eventBus.publish({
        id: `funding-kick-${pos.symbol}-${now}-${this.seq}`,
        type: 'execution.position.close.requested',
        ts: now,
        source: 'funding-exit-manager',
        symbol: pos.symbol,
        payload: {
          symbol: pos.symbol,
          orderId: pos.orderId,
          side: pos.side,
          reason: 'FUNDING_KICK',
          rateBps,
          secsToFunding,
        },
      });
    }
  }
}
