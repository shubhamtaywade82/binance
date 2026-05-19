import { EventBus } from '../events/event-bus';
import {
  DomainEvent,
  OrderRequestedPayload,
  OrderValidatedPayload,
} from '@coindcx/contracts';
import { AppConfig } from '../../config';
import { marketClock } from '../time/market-clock';
import { CorrelationGuard, type CorrelationPair } from '../../risk/correlation-guard';

interface PositionExposure {
  side: 'LONG' | 'SHORT';
  /** Sum of (price * quantity) across all fills. Used for portfolio caps. */
  notional: number;
  /**
   * M-19: cost basis including paid taker fees. Equals notional + accumulated
   * feeUsdt from each fill event. Used by downstream PnL math that needs the
   * actual money out, not just the underlying notional. RiskEngine does not
   * use this for caps (those track notional alone) but persists it so the
   * dashboard / equity service can compute realized PnL precisely.
   */
  costBasis: number;
  quantity: number;
  /**
   * Derived VWAP: notional / quantity. Recomputed on every pyramid add. Tracked
   * explicitly (not on-the-fly) so callers that read it during an update window
   * see a consistent snapshot.
   */
  entryPrice: number;
}

/**
 * RiskEngine — gates every order. Subscribes `execution.order.requested`,
 * checks portfolio invariants, emits `.accepted` or `.rejected`. Tracks
 * exposure via `execution.order.filled` and `execution.position.closed`.
 *
 * Invariants enforced:
 *   - MAX_TOTAL_EXPOSURE_USDT       — sum of open notionals
 *   - MAX_OPEN_SYMBOLS              — distinct open symbols
 *   - MAX_OPEN_POSITIONS            — total open positions
 *   - MAX_NOTIONAL_USDT             — per-order cap
 *   - duplicate symbol guard        — no flip-without-close
 */
export class RiskEngine {
  private totalNotional = 0;
  private positions = new Map<string, PositionExposure>();
  private seq = 0;
  private readonly correlationGuard?: CorrelationGuard;
  /** Symbols flagged stale by the FreshnessWatchdog. Orders for these are rejected. */
  private readonly staleSymbols = new Set<string>();
  /**
   * H-2 / H-3: track fills already processed (by orderId) so duplicate
   * `execution.order.filled` events (e.g. from CoinDCX user-data WS firing on
   * every mark-move position update) don't double-count notional.
   */
  private readonly processedFillIds = new Set<string>();
  /**
   * Accepted-but-not-yet-filled symbols. Closes the race where multiple
   * signals arrive within the adapter latency window (≈150ms for paper):
   * without a reservation each validate() sees positions.size unchanged
   * and all N pass through the cap. Released on `execution.order.filled`,
   * `execution.order.rejected`, or `execution.position.closed`.
   */
  private readonly pendingSymbols = new Set<string>();
  private static readonly REDUCE_REASONS = new Set([
    'PARTIAL_TP', 'TP', 'TP1', 'TP2', 'SL', 'TRAIL', 'SMC_EXIT', 'TIME_STOP',
    'FUNDING_KICK', 'LIQUIDATION', 'MANUAL', 'REVERSAL', 'EXCHANGE_CLOSE',
    'WATERMARK_EXIT', 'SIGNAL_REVERSAL',
  ]);

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
  ) {
    const pairs = this.parseCorrelationPairs((cfg as any).CORRELATION_PAIRS_JSON);
    if (pairs.length > 0) {
      this.correlationGuard = new CorrelationGuard(pairs, {
        threshold: Number((cfg as any).CORRELATION_THRESHOLD) || 0.7,
      });
    }
    this.subscribe();
  }

  /** Test/inspection helper. */
  public isStale(symbol: string): boolean {
    return this.staleSymbols.has(symbol);
  }

  private parseCorrelationPairs(raw: unknown): CorrelationPair[] {
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (p): p is CorrelationPair =>
          p && typeof p.symbolA === 'string' && typeof p.symbolB === 'string' && typeof p.correlation === 'number',
      );
    } catch {
      return [];
    }
  }

  public getExposure(): { total: number; symbols: number; positions: Map<string, PositionExposure> } {
    return { total: this.totalNotional, symbols: this.positions.size, positions: new Map(this.positions) };
  }

  /**
   * Recover in-memory exposure from a previously-open snapshot. Call on
   * startup after restoring PaperWallet so the engine doesn't think the
   * account is flat while the adapter still holds positions — without this,
   * a restart while in-position would let strategies emit opposite-side
   * orders unimpeded and the adapter would record them as REVERSAL.
   */
  public seedPositions(positions: Array<{ symbol: string; side: 'LONG' | 'SHORT'; quantity: number; entryPrice: number }>): void {
    for (const p of positions) {
      if (!p.symbol || p.quantity <= 0 || p.entryPrice <= 0) continue;
      const notional = p.quantity * p.entryPrice;
      // M-19: reconciled positions from the exchange have no fee record locally,
      // so costBasis is initialised to notional (fees are unknown). Subsequent
      // fills via onFilled will accumulate fees correctly.
      this.positions.set(p.symbol, {
        side: p.side,
        quantity: p.quantity,
        notional,
        costBasis: notional,
        entryPrice: p.entryPrice,
      });
      this.totalNotional += notional;
    }
  }

  private subscribe(): void {
    // When SignalAllocator is wired it republishes accepted candidates onto
    // `execution.order.requested.allocated`. Allocator forwards unscored
    // payloads onto the same channel as well, so this single subscription
    // covers both scored and unscored signals without double-validating.
    const useAllocated = Boolean((this.cfg as any).SIGNAL_ALLOCATOR_ENABLED);
    const channel = useAllocated ? 'execution.order.requested.allocated' : 'execution.order.requested';
    this.eventBus.subscribe<OrderRequestedPayload>(channel, (e) => this.validate(e));
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (sym) this.pendingSymbols.delete(sym);
      this.onFilled(e.payload);
    });
    this.eventBus.subscribe('execution.order.rejected', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.requested?.symbol ?? e.payload?.symbol) as string | undefined;
      if (sym) this.pendingSymbols.delete(sym);
    });
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (sym) this.pendingSymbols.delete(sym);
      this.onClosed(e.payload);
    });
    // C-7: stale-feed risk-off. FreshnessWatchdog publishes system.stale when
    // no market data has arrived for a symbol within the staleness threshold,
    // and system.fresh when data flow recovers. Orders for stale symbols are
    // rejected — entering on cached prices is a fast path to liquidation.
    this.eventBus.subscribe('system.stale', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (sym) this.staleSymbols.add(sym);
    });
    this.eventBus.subscribe('system.fresh', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (sym) this.staleSymbols.delete(sym);
    });
    // M-3: runtime correlation matrix updates. Publishers (a Redis pubsub
    // bridge, a nightly scheduled job, an operator REST call) emit
    // `risk.correlations.update` with `{ pairs: CorrelationPair[],
    // threshold?: number }` to refresh the guard without restarting the bot.
    // Market-regime shifts can invalidate baked-in correlations in hours.
    this.eventBus.subscribe('risk.correlations.update', (e: DomainEvent<any>) => {
      this.updateCorrelations(e.payload?.pairs ?? [], e.payload?.threshold);
    });
  }

  /**
   * M-3: replace the current correlation matrix at runtime. Creates a guard
   * if one didn't exist (allows initialising correlations after boot). When
   * `pairs` is empty the existing guard is left in place — call with an
   * explicit `[]` and `threshold:Infinity` to disable.
   */
  public updateCorrelations(pairs: CorrelationPair[], threshold?: number): void {
    if (!pairs || pairs.length === 0) return;
    const t = Number.isFinite(threshold) && (threshold as number) > 0
      ? (threshold as number)
      : Number((this.cfg as any).CORRELATION_THRESHOLD) || 0.7;
    if (!this.correlationGuard) {
      (this as any).correlationGuard = new CorrelationGuard(pairs, { threshold: t });
    } else {
      this.correlationGuard.updateCorrelations(pairs);
    }
  }

  private validate(event: DomainEvent<OrderRequestedPayload>): void {
    const payload = event.payload;
    const { symbol, quantity } = payload;
    const price = payload.price ?? 0;
    const orderNotional = quantity * price;

    // C-7: refuse to fire orders on a stale feed. The strategy may still be
    // emitting signals from cached candles but the exchange price has moved.
    if (this.staleSymbols.has(symbol)) {
      this.reject(payload, 'STALE_FEED');
      return;
    }

    const maxTotal = Number((this.cfg as any).MAX_TOTAL_EXPOSURE_USDT) || Infinity;
    const maxSymbols = Number((this.cfg as any).MAX_OPEN_SYMBOLS) || Infinity;
    const maxPositions = Number(this.cfg.MAX_OPEN_POSITIONS) || Infinity;
    const maxPerOrder = Number(this.cfg.MAX_NOTIONAL_USDT) || Infinity;

    if (orderNotional <= 0) {
      this.reject(payload, 'INVALID_NOTIONAL');
      return;
    }
    // H-7: notional cap must apply to the TOTAL position notional (existing +
    // incoming) for a pyramiding add, not just the incremental order. Without
    // this, a series of incremental same-side orders each below the cap can
    // stack into a position multiple times the cap.
    const existingForSymbol = this.positions.get(symbol);
    const projectedPositionNotional = existingForSymbol && existingForSymbol.side === payload.side
      ? existingForSymbol.notional + orderNotional
      : orderNotional;
    if (projectedPositionNotional > maxPerOrder) {
      this.reject(payload, 'MAX_PER_ORDER_NOTIONAL_EXCEEDED');
      return;
    }
    if (this.totalNotional + orderNotional > maxTotal) {
      this.reject(payload, 'MAX_TOTAL_EXPOSURE_EXCEEDED');
      return;
    }
    // Count pending (accepted-but-not-yet-filled) symbols toward both caps so
    // signals arriving inside the adapter latency window can't all slip
    // through against an unchanged positions.size.
    const isNewSymbol = !this.positions.has(symbol) && !this.pendingSymbols.has(symbol);
    const effectiveSymbolCount = this.positions.size + this.pendingSymbols.size;
    if (isNewSymbol && effectiveSymbolCount >= maxSymbols) {
      this.reject(payload, 'MAX_OPEN_SYMBOLS_EXCEEDED');
      return;
    }
    if (isNewSymbol && effectiveSymbolCount >= maxPositions) {
      this.reject(payload, 'MAX_OPEN_POSITIONS_EXCEEDED');
      return;
    }
    const existing = this.positions.get(symbol);
    if (existing && existing.side !== payload.side) {
      this.reject(payload, 'OPPOSITE_SIDE_OPEN_POSITION');
      return;
    }

    // Correlation guard: prevent stacked exposure on assets that move together.
    if (this.correlationGuard) {
      const openMap = new Map<string, 'LONG' | 'SHORT'>();
      for (const [sym, exposure] of this.positions) openMap.set(sym, exposure.side);
      const verdict = this.correlationGuard.wouldViolate(symbol, payload.side, openMap);
      if (verdict.blocked) {
        this.reject(payload, `CORRELATION_BLOCKED:${verdict.reason}`);
        return;
      }
    }

    // Reserve a slot for this symbol so concurrent in-flight signals see the
    // updated effective count. Released on filled/rejected/closed.
    if (!this.positions.has(symbol)) this.pendingSymbols.add(symbol);

    const ts = marketClock.now();
    this.seq += 1;
    const validated: OrderValidatedPayload = {
      ...payload,
      riskMetrics: {
        currentTotalNotional: this.totalNotional,
        orderNotional,
        openSymbols: this.positions.size,
      },
    };
    this.eventBus.publish({
      id: `order-acc-${symbol}-${ts}-${this.seq}`,
      type: 'execution.order.accepted',
      ts,
      source: 'risk-engine',
      symbol,
      payload: validated,
    });
  }

  private onFilled(payload: any): void {
    const symbol: string | undefined = payload.symbol;
    if (!symbol) return;
    // C-9: STARTUP_REARM events are synthetic re-emissions used by exit
    // managers to register pre-crash positions. RiskEngine state was already
    // primed by `seedPositions` from the reconciliation pass earlier in boot;
    // accumulating notional again here would double-count exposure.
    if (payload?.reason === 'STARTUP_REARM') return;

    // H-3: idempotent on orderId. CoinDcxUserDataWs fires position_update
    // events on mark moves AND on partial closes, all carrying the same
    // position_id — accumulating each as a fresh fill triples the in-memory
    // notional within the first minute of any open position.
    const orderId = String(payload.orderId ?? '');
    if (orderId && this.processedFillIds.has(orderId)) return;
    if (orderId) this.processedFillIds.add(orderId);

    const qty = Number(payload.quantity) || 0;
    const price = Number(payload.price) || 0;
    if (qty <= 0 || price <= 0) return;
    const side: 'LONG' | 'SHORT' = payload.side === 'SHORT' ? 'SHORT' : 'LONG';
    const notional = qty * price;

    // H-2: reduce-only / close-side fills must not accumulate notional. They
    // are emitted by exit managers (PARTIAL_TP via TpLadderManager, TRAIL via
    // TrailingStopManager, etc.) and represent position-reducing trades, not
    // new openings. The matching `execution.position.closed` event drives
    // exposure cleanup in onClosed().
    const reason = String(payload?.reason ?? '');
    const isReduceOnly = Boolean(payload?.reduceOnly) ||
      RiskEngine.REDUCE_REASONS.has(reason);
    if (isReduceOnly) return;

    const feeUsdt = Number(payload?.feeUsdt) || 0;
    const prev = this.positions.get(symbol);
    if (prev) {
      // H-2: never aggregate an opposite-side fill onto an existing position.
      // RiskEngine.validate rejects with OPPOSITE_SIDE_OPEN_POSITION upstream,
      // but if the fill somehow reaches us anyway (state desync), treat it
      // defensively as a noop rather than silently averaging two sides.
      if (prev.side !== side) return;
      const newQty = prev.quantity + qty;
      const newNotional = prev.notional + notional;
      const newCostBasis = prev.costBasis + notional + feeUsdt;
      this.totalNotional += notional;
      this.positions.set(symbol, {
        side,
        quantity: newQty,
        notional: newNotional,
        costBasis: newCostBasis,
        entryPrice: newNotional / newQty,
      });
    } else {
      this.totalNotional += notional;
      this.positions.set(symbol, {
        side,
        quantity: qty,
        notional,
        costBasis: notional + feeUsdt,
        entryPrice: price,
      });
    }
  }

  private onClosed(payload: any): void {
    const symbol: string | undefined = payload.symbol;
    if (!symbol) return;
    const prev = this.positions.get(symbol);
    if (!prev) return;

    const closedQty = Number(payload.quantity) || 0;
    const reason = String(payload?.reason ?? '');
    if (reason === 'PARTIAL_TP' && closedQty > 0 && closedQty < prev.quantity) {
      const reduceRatio = closedQty / prev.quantity;
      const notionalReduction = prev.notional * reduceRatio;
      const nextQuantity = Math.max(0, prev.quantity - closedQty);
      const nextNotional = Math.max(0, prev.notional - notionalReduction);
      this.totalNotional = Math.max(0, this.totalNotional - notionalReduction);
      this.positions.set(symbol, {
        ...prev,
        quantity: nextQuantity,
        notional: nextNotional,
      });
      return;
    }

    this.totalNotional = Math.max(0, this.totalNotional - prev.notional);
    this.positions.delete(symbol);
    // H-3: free the processed-fill id so a subsequent open of the same symbol
    // (different orderId) records correctly. The set is bounded by the number
    // of concurrently open positions plus their close events.
    const orderId = String(payload.orderId ?? '');
    if (orderId) this.processedFillIds.delete(orderId);
  }

  private reject(payload: OrderRequestedPayload, reason: string): void {
    const ts = marketClock.now();
    this.seq += 1;
    this.eventBus.publish({
      id: `order-rej-${payload.symbol}-${ts}-${this.seq}`,
      type: 'execution.order.rejected',
      ts,
      source: 'risk-engine',
      symbol: payload.symbol,
      payload: { reason, requested: payload },
    });
  }
}
