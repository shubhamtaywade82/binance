import type {
  CloseReason,
  ClosedPosition,
  ExecutionAdapter,
  OrderRequest,
  OrderResult,
} from '../src/execution/types';

/** Minimal adapter so `PositionManager` TP/SL paths can be tested without CoinDCX or paper stack. */
export function createStubExecutionAdapter(fillPriceScale = 1): ExecutionAdapter {
  return {
    name: 'paper',
    async placeOrder(req: OrderRequest): Promise<OrderResult> {
      const price = req.referencePrice * fillPriceScale;
      return {
        ok: true,
        orderId: 'stub-order',
        fill: {
          price,
          quantity: req.quantity,
          feeUsdt: 0,
          slippageUsdt: 0,
          latencyMs: 0,
          timestamp: Date.now(),
        },
      };
    },
    async closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
      return {
        orderId,
        side: 'LONG',
        entryPrice: 100,
        exitPrice: 100,
        quantity: 0.1,
        reason,
        grossUsdt: 0,
        feesUsdt: 0,
        fundingUsdt: 0,
        netUsdt: 0,
        openedAt: 0,
        closedAt: Date.now(),
      };
    },
  };
}
