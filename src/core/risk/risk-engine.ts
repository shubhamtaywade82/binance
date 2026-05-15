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
  notional: number;
  quantity: number;
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

  private subscribe(): void {
    // When SignalAllocator is wired it republishes accepted candidates onto
    // `execution.order.requested.allocated`. Subscribing only to that channel
    // would break the strategies that don't go through the allocator (no
    // score field). Subscribe to both; the allocator forwards short-circuit
    // for unscored payloads, so we'll never see the same payload twice.
    const useAllocated = Boolean((this.cfg as any).SIGNAL_ALLOCATOR_ENABLED);
    const channel = useAllocated ? 'execution.order.requested.allocated' : 'execution.order.requested';
    this.eventBus.subscribe<OrderRequestedPayload>(channel, (e) => this.validate(e));
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => this.onFilled(e.payload));
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => this.onClosed(e.payload));
  }

  private validate(event: DomainEvent<OrderRequestedPayload>): void {
    const payload = event.payload;
    const { symbol, quantity } = payload;
    const price = payload.price ?? 0;
    const orderNotional = quantity * price;

    const maxTotal = Number((this.cfg as any).MAX_TOTAL_EXPOSURE_USDT) || Infinity;
    const maxSymbols = Number((this.cfg as any).MAX_OPEN_SYMBOLS) || Infinity;
    const maxPositions = Number(this.cfg.MAX_OPEN_POSITIONS) || Infinity;
    const maxPerOrder = Number(this.cfg.MAX_NOTIONAL_USDT) || Infinity;

    if (orderNotional <= 0) {
      this.reject(payload, 'INVALID_NOTIONAL');
      return;
    }
    if (orderNotional > maxPerOrder) {
      this.reject(payload, 'MAX_PER_ORDER_NOTIONAL_EXCEEDED');
      return;
    }
    if (this.totalNotional + orderNotional > maxTotal) {
      this.reject(payload, 'MAX_TOTAL_EXPOSURE_EXCEEDED');
      return;
    }
    if (!this.positions.has(symbol) && this.positions.size >= maxSymbols) {
      this.reject(payload, 'MAX_OPEN_SYMBOLS_EXCEEDED');
      return;
    }
    if (this.positions.size >= maxPositions && !this.positions.has(symbol)) {
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
    const qty = Number(payload.quantity) || 0;
    const price = Number(payload.price) || 0;
    if (qty <= 0 || price <= 0) return;
    const side: 'LONG' | 'SHORT' = payload.side === 'SHORT' ? 'SHORT' : 'LONG';
    const notional = qty * price;
    const prev = this.positions.get(symbol);
    if (prev) {
      const newQty = prev.quantity + qty;
      const newNotional = prev.notional + notional;
      this.totalNotional += notional;
      this.positions.set(symbol, {
        side,
        quantity: newQty,
        notional: newNotional,
        entryPrice: newNotional / newQty,
      });
    } else {
      this.totalNotional += notional;
      this.positions.set(symbol, { side, quantity: qty, notional, entryPrice: price });
    }
  }

  private onClosed(payload: any): void {
    const symbol: string | undefined = payload.symbol;
    if (!symbol) return;
    const prev = this.positions.get(symbol);
    if (!prev) return;
    this.totalNotional = Math.max(0, this.totalNotional - prev.notional);
    this.positions.delete(symbol);
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
