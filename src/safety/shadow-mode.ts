import type {
  CloseReason,
  ClosedPosition,
  ExecutionAdapter,
  OrderRequest,
  OrderResult,
} from '../execution/types';

interface MinimalLogger {
  warn(msg: string, meta?: object): void;
}

const mockFill = (req: OrderRequest) => ({
  price: req.referencePrice,
  quantity: req.quantity,
  feeUsdt: 0,
  slippageUsdt: 0,
  latencyMs: 0,
  timestamp: Date.now(),
});

/**
 * Wraps a real {@link ExecutionAdapter} and intercepts mutating calls when shadow mode is active.
 *
 * All order placement / modification / cancellation is logged but never forwarded to the
 * underlying adapter.  Read-only operations (`onMark`) pass through unchanged.
 */
export class ShadowMode implements ExecutionAdapter {
  readonly name;

  constructor(
    private readonly real: ExecutionAdapter,
    private readonly logger: MinimalLogger,
  ) {
    this.name = real.name;
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    this.logger.warn('[SHADOW] placeOrder suppressed', {
      pair: req.pair,
      side: req.side,
      qty: req.quantity,
      refPrice: req.referencePrice,
    });
    return {
      ok: true,
      orderId: `shadow-${Date.now()}`,
      fill: mockFill(req),
    };
  }

  async closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
    this.logger.warn('[SHADOW] closePosition suppressed', { orderId, reason });
    const now = Date.now();
    return {
      orderId,
      side: 'LONG',
      leverage: 1,
      entryPrice: 0,
      exitPrice: 0,
      quantity: 0,
      reason,
      grossUsdt: 0,
      feesUsdt: 0,
      fundingUsdt: 0,
      netUsdt: 0,
      openedAt: now,
      closedAt: now,
    };
  }

  onMark(symbol: string, markPrice: number): void {
    this.real.onMark?.(symbol, markPrice);
  }

  async setLeverage(pair: string, lev: number): Promise<void> {
    this.logger.warn('[SHADOW] setLeverage suppressed', { pair, lev });
  }
}
