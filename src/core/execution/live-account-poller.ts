import { EventBus } from '../events/event-bus';
import type { CoinDcxExecutionAdapter } from '../../execution/coindcx-adapter';
import type { RedisPaperStateStore } from '../../persistence/redis-paper-state';
import type { PgWriter } from '../../persistence/pg-writer';
import { marketClock } from '../time/market-clock';

interface FxProvider { getInrPerUsdt(): number }

/**
 * LiveAccountPoller — periodically pulls wallet + open positions from the
 * CoinDCX REST API and projects them onto the same event-bus shape that
 * paper-mode emits, plus the same Redis hot-cache + Postgres writes.
 *
 * Why poll: CoinDCX user-data WebSocket docs incomplete in the public
 * reference. REST poll at PAPER_EQUITY_SNAPSHOT_SEC cadence is good enough
 * for paper-style observability; WS push can replace this later without
 * changing downstream consumers.
 *
 * Events published:
 *   wallet                    every poll (dashboard WS / Redis / Postgres)
 *   position_update           every poll
 *   position_opened           when a new orderId appears
 *   position_closed           when an orderId disappears
 *
 * Postgres writes:
 *   equity_snapshots          one row per poll (with inr_per_usdt FX)
 *   positions                 upsert / delete per fill
 */
export class LiveAccountPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevPositionIds = new Set<string>();
  private missCount = new Map<string, number>();
  private seq = 0;

  constructor(
    private readonly eventBus: EventBus,
    private readonly adapter: CoinDcxExecutionAdapter,
    private readonly opts: {
      pollMs: number;
      pgWriter?: PgWriter;
      redisState?: RedisPaperStateStore;
      fxRate?: FxProvider;
      /** Consecutive empty polls required before declaring a position closed. */
      missConfirms: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Triggered by CoinDcxUserDataWs on balance_update — fetches fresh equity + positions
   *  so the wallet broadcast reflects the change within ~200ms (REST roundtrip)
   *  instead of waiting up to PAPER_EQUITY_SNAPSHOT_SEC. */
  public requestFreshSnapshot(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    const [wallet, positions] = await Promise.all([
      this.adapter.getWalletState().catch(() => null),
      this.adapter.getOpenPositions().catch(() => []),
    ]);
    const now = marketClock.now();

    if (wallet) {
      this.eventBus.publish({
        id: `wallet-${now}-${++this.seq}`,
        type: 'wallet.update',
        ts: now,
        source: 'live-account-poller',
        payload: { ...wallet, mode: 'live' },
      });
      void this.opts.redisState?.setWallet(wallet as any);
      void this.opts.redisState?.publishUpdate('wallet', { equityUsdt: wallet.equityUsdt });

      if (this.opts.pgWriter?.isConnected) {
        void this.opts.pgWriter.writeEquitySnapshot(
          wallet as any,
          0,
          positions.length,
          this.opts.fxRate?.getInrPerUsdt(),
        );
      }
    }

    // Detect open/close diffs
    const currentIds = new Set<string>();
    for (const p of positions) {
      const oid = String(p.orderId ?? p.symbol);
      currentIds.add(oid);
      if (!this.prevPositionIds.has(oid)) {
        this.eventBus.publish({
          id: `live-pos-open-${oid}-${now}`,
          type: 'execution.order.filled',
          ts: now,
          source: 'live-account-poller',
          symbol: p.symbol,
          payload: { ...p, orderId: oid, price: p.entryPrice },
        });
      }
      if (this.opts.pgWriter?.isConnected) {
        void this.opts.pgWriter.upsertPosition({
          orderId: oid,
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity,
          entryPrice: p.entryPrice,
          leverage: p.leverage,
          marginUsdt: p.marginUsdt,
          liqPrice: p.liqPrice,
          openedAt: p.openedAt,
          unrealizedPnl: p.unrealizedUsdt,
        });
      }
      void this.opts.redisState?.upsertPosition(oid, p);
    }
    // Debounce close detection: only declare a position closed after MISS_CONFIRMS
    // consecutive empty polls. CoinDCX REST occasionally returns an empty array
    // for ~1-2s between fills — without debounce the synthetic close trips
    // strategy.inPosition=false and lets the next bar fire an opposite-side
    // order before the position truly closed → REVERSAL trade.
    for (const oid of this.prevPositionIds) {
      if (currentIds.has(oid)) {
        this.missCount.delete(oid);
        continue;
      }
      const misses = (this.missCount.get(oid) ?? 0) + 1;
      this.missCount.set(oid, misses);
      if (misses < this.opts.missConfirms) {
        currentIds.add(oid); // keep tracking — likely a transient empty response
        continue;
      }
      // Confirmed close
      this.missCount.delete(oid);
      this.eventBus.publish({
        id: `live-pos-close-${oid}-${now}`,
        type: 'execution.position.closed',
        ts: now,
        source: 'live-account-poller',
        payload: { orderId: oid, reason: 'EXCHANGE_RECONCILE' },
      });
      void this.opts.pgWriter?.removePosition(oid);
      void this.opts.redisState?.removePosition(oid);
    }
    this.prevPositionIds = currentIds;

    // Always broadcast the latest position snapshot for the dashboard.
    this.eventBus.publish({
      id: `pos-snap-${now}-${++this.seq}`,
      type: 'position_update',
      ts: now,
      source: 'live-account-poller',
      payload: { positions, mode: 'live' },
    });
  }
}
