import type { EventBus } from '../events/event-bus';
import type { DomainEvent } from '@coindcx/contracts';

export type OrderLifecycleState =
  | 'IDLE'
  | 'SIGNAL_CANDIDATE'
  | 'PLAN_READY'
  | 'RISK_APPROVED'
  | 'SUBMITTED'
  | 'FILLED'
  | 'SUPERVISING'
  | 'CLOSING'
  | 'CLOSED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'HALTED';

/** States from which a new signal can be accepted. */
const AVAILABLE_STATES = new Set<OrderLifecycleState>([
  'IDLE', 'CLOSED', 'REJECTED', 'EXPIRED',
]);

const VALID_TRANSITIONS: Readonly<Record<OrderLifecycleState, OrderLifecycleState[]>> = {
  IDLE:             ['SIGNAL_CANDIDATE', 'HALTED'],
  SIGNAL_CANDIDATE: ['PLAN_READY', 'REJECTED', 'IDLE', 'HALTED'],
  PLAN_READY:       ['RISK_APPROVED', 'REJECTED', 'EXPIRED', 'IDLE', 'HALTED'],
  RISK_APPROVED:    ['SUBMITTED', 'REJECTED', 'HALTED'],
  SUBMITTED:        ['FILLED', 'REJECTED', 'EXPIRED', 'HALTED'],
  FILLED:           ['SUPERVISING', 'CLOSING', 'HALTED'],
  SUPERVISING:      ['CLOSING', 'HALTED'],
  CLOSING:          ['CLOSED', 'SUPERVISING', 'HALTED'],
  CLOSED:           ['IDLE'],
  REJECTED:         ['IDLE'],
  EXPIRED:          ['IDLE'],
  HALTED:           ['IDLE'],
};

export interface StateTransition {
  from: OrderLifecycleState;
  to: OrderLifecycleState;
  ts: number;
  reason?: string;
  tradeId?: string;
}

export class SymbolOrderStateMachine {
  private state: OrderLifecycleState = 'IDLE';
  private history: StateTransition[] = [];
  private _activeTradeId: string | null = null;

  constructor(public readonly symbol: string) {}

  public getState(): OrderLifecycleState { return this.state; }
  public getTradeId(): string | null { return this._activeTradeId; }
  public getHistory(): readonly StateTransition[] { return this.history; }

  public isAvailable(): boolean {
    return AVAILABLE_STATES.has(this.state);
  }

  /**
   * Attempt a state transition. Returns true on success, false if the
   * transition is not valid from the current state.
   */
  public transition(
    to: OrderLifecycleState,
    reason?: string,
    tradeId?: string,
  ): boolean {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(to)) return false;

    const entry: StateTransition = {
      from: this.state,
      to,
      ts: Date.now(),
      reason,
      tradeId: tradeId ?? this._activeTradeId ?? undefined,
    };
    this.history.push(entry);
    // Bound history to last 100 transitions per symbol.
    if (this.history.length > 100) this.history.splice(0, this.history.length - 100);

    this.state = to;
    if (tradeId) this._activeTradeId = tradeId;
    if (to === 'IDLE' || to === 'CLOSED' || to === 'REJECTED' || to === 'EXPIRED') {
      this._activeTradeId = null;
    }
    return true;
  }

  /** Force-reset to IDLE (emergency / operator halt recovery). */
  public reset(reason = 'manual_reset'): void {
    this.history.push({ from: this.state, to: 'IDLE', ts: Date.now(), reason });
    this.state = 'IDLE';
    this._activeTradeId = null;
  }
}

/**
 * OrderStateRegistry — central store of per-symbol state machines.
 *
 * Optionally subscribes to EventBus to auto-advance state on standard
 * fill / close / reject events, keeping all state in one place.
 */
export class OrderStateRegistry {
  private machines = new Map<string, SymbolOrderStateMachine>();

  constructor(eventBus?: EventBus) {
    if (eventBus) this.wireEventBus(eventBus);
  }

  public get(symbol: string): SymbolOrderStateMachine {
    let m = this.machines.get(symbol);
    if (!m) {
      m = new SymbolOrderStateMachine(symbol);
      this.machines.set(symbol, m);
    }
    return m;
  }

  public getAll(): ReadonlyMap<string, SymbolOrderStateMachine> {
    return this.machines;
  }

  /** Snapshot of all symbol states — useful for dashboard / health. */
  public snapshot(): Array<{ symbol: string; state: OrderLifecycleState; tradeId: string | null }> {
    return Array.from(this.machines.entries()).map(([symbol, m]) => ({
      symbol,
      state: m.getState(),
      tradeId: m.getTradeId(),
    }));
  }

  private wireEventBus(bus: EventBus): void {
    // order.accepted → RISK_APPROVED
    bus.subscribe('execution.order.accepted', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (!sym) return;
      this.get(sym).transition('RISK_APPROVED', 'order_accepted');
    });

    // order.submitted → SUBMITTED
    bus.subscribe('execution.order.submitted', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (!sym) return;
      this.get(sym).transition('SUBMITTED', 'order_submitted');
    });

    // order.filled → SUPERVISING (exit managers armed)
    bus.subscribe('execution.order.filled', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (!sym) return;
      const m = this.get(sym);
      m.transition('FILLED', 'order_filled', String(e.payload?.orderId ?? ''));
      m.transition('SUPERVISING', 'exit_managers_armed');
    });

    // order.rejected → REJECTED → auto-reset to IDLE
    bus.subscribe('execution.order.rejected', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol ?? e.payload?.requested?.symbol) as string | undefined;
      if (!sym) return;
      const m = this.get(sym);
      if (m.transition('REJECTED', String(e.payload?.reason ?? 'rejected'))) {
        m.transition('IDLE', 'auto_reset');
      }
    });

    // position.closed → CLOSED → IDLE
    bus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
      const sym = (e.symbol ?? e.payload?.symbol) as string | undefined;
      if (!sym) return;
      const m = this.get(sym);
      m.transition('CLOSING', 'position_closing');
      m.transition('CLOSED', 'position_closed');
      m.transition('IDLE', 'auto_reset');
    });
  }
}
