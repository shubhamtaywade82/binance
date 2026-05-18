import { EventBus } from '../events/event-bus';
import {
  DomainEvent,
  OrderValidatedPayload,
  OrderRequestedPayload,
} from '@coindcx/contracts';
import { ExecutionAdapter, OrderRequest } from '../../execution/types';
import { AppConfig } from '../../config';
import { marketClock } from '../time/market-clock';
import type { FillMetadataStore } from './fill-metadata-store';

/**
 * ExecutionBridge — subscribes to `execution.order.accepted` (emitted by
 * RiskEngine after validating a request) and forwards to the configured
 * `ExecutionAdapter` (paper / Binance / CoinDCX). Emits:
 *   execution.order.submitted   on successful adapter call
 *   execution.order.filled      with fill price + fees
 *   execution.order.rejected    on adapter error
 *
 * This is the SOLE consumer of order.accepted — keeps live/paper parity
 * because both routes go through identical event chain.
 */
export class ExecutionBridge {
  private seq = 0;

  constructor(
    private readonly cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly adapter: ExecutionAdapter,
    /** C-9: persist fill metadata for cross-restart exit-manager re-arming. */
    private readonly fillMetadataStore?: FillMetadataStore,
  ) {
    this.subscribe();
    this.subscribeForMetadataUpsert();
  }

  /**
   * C-9: capture every successful fill's metadata to disk so exit managers
   * (trail / TP ladder / structure / time stop) can be re-armed on restart.
   * The store survives kill -9; restart re-emits synthetic
   * `execution.order.filled` events from these records.
   */
  private subscribeForMetadataUpsert(): void {
    if (!this.fillMetadataStore) return;
    this.eventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) => {
      const p = e.payload;
      const orderId = String(p?.orderId ?? '');
      const symbol = (p?.symbol ?? e.symbol) as string | undefined;
      if (!orderId || !symbol) return;
      this.fillMetadataStore!.upsert({
        orderId,
        symbol,
        side: (p?.side === 'SHORT' ? 'SHORT' : 'LONG'),
        quantity: Number(p?.quantity) || 0,
        price: Number(p?.price) || 0,
        stopLoss: Number(p?.stopLoss) || undefined,
        takeProfit: Number(p?.takeProfit) || undefined,
        strategyId: p?.strategyId,
        tpLadder: p?.tpLadder,
        maxHoldBars: p?.maxHoldBars,
        regime: p?.regime,
        modeId: p?.modeId,
        atrAtEntry: Number(p?.atrAtEntry) || undefined,
        openedAt: Number(p?.openedAt) || Date.now(),
      });
    });
    this.eventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) => {
      const orderId = String(e.payload?.orderId ?? '');
      if (orderId) this.fillMetadataStore!.remove(orderId);
    });
  }

  private subscribe(): void {
    this.eventBus.subscribe<OrderValidatedPayload>('execution.order.accepted', (e) => {
      void this.handleAccepted(e);
    });
  }

  private async handleAccepted(event: DomainEvent<OrderValidatedPayload>): Promise<void> {
    const p = event.payload;
    if (!p.symbol || !p.price) return;

    const req: OrderRequest = {
      pair: p.symbol,
      side: p.side,
      quantity: p.quantity,
      leverage: Number(this.cfg.LEVERAGE) || 1,
      marginCurrency: 'USDT',
      referencePrice: p.price,
      takeProfit: p.takeProfit,
      stopLoss: p.stopLoss,
      reason: (p as any).reason,
      // Idempotency: bus event id is unique per validated order request. Adapters
      // dedupe duplicate submissions (e.g. retries triggered by transient errors)
      // by this key and derive the exchange-side client_order_id from it.
      idempotencyKey: p.correlationId ?? event.id,
    };

    this.seq += 1;
    const submittedTs = marketClock.now();
    this.eventBus.publish({
      id: `order-sub-${p.symbol}-${submittedTs}-${this.seq}`,
      type: 'execution.order.submitted',
      ts: submittedTs,
      source: `execution:${this.adapter.name}`,
      symbol: p.symbol,
      payload: {
        orderId: `pending-${submittedTs}-${this.seq}`,
        symbol: p.symbol,
        side: p.side === 'LONG' ? 'BUY' : 'SELL',
        type: p.type,
        quantity: p.quantity,
        price: p.price,
        strategyId: p.strategyId,
      },
    });

    try {
      const result = await this.adapter.placeOrder(req);
      const ts = marketClock.now();
      // In live mode, the CoinDCX user-data WS emits the authoritative
      // execution.order.filled with the exchange's position_id. Skip the
      // synthetic publish to avoid double-counting in RiskEngine + trail.
      const suppressFill =
        this.adapter.name === 'live' && Boolean((this.cfg as any).LIVE_USE_WS_FOR_FILLS);
      if (result.ok && !suppressFill) {
        this.eventBus.publish({
          id: `order-fill-${result.orderId}`,
          type: 'execution.order.filled',
          ts,
          source: `execution:${this.adapter.name}`,
          symbol: p.symbol,
          payload: {
            orderId: result.orderId,
            symbol: p.symbol,
            side: p.side,
            quantity: result.fill.quantity,
            price: result.fill.price,
            feeUsdt: result.fill.feeUsdt,
            slippageUsdt: result.fill.slippageUsdt,
            latencyMs: result.fill.latencyMs,
            liqPrice: this.lookupLiqPrice(result.orderId),
            leverage: req.leverage,
            strategyId: p.strategyId,
            correlationId: p.correlationId,
            reason: (p as any).reason,
            // Forward strategy-attached exit metadata so the TpLadderManager
            // and other exit managers can consume it without re-querying.
            tpLadder: (p as any).tpLadder,
            trailAfterLadder: (p as any).trailAfterLadder,
            regime: (p as any).regime,
            modeId: (p as any).modeId,
            maxHoldBars: (p as any).maxHoldBars,
          },
        });
      } else if (!result.ok) {
        this.publishRejected(p, result.error ?? 'ADAPTER_FAILURE', ts);
      }
    } catch (err) {
      this.publishRejected(p, (err as Error).message || 'ADAPTER_THREW', marketClock.now());
    }
  }

  /** Best-effort lookup of liquidation price for the just-filled order. Paper adapter
   *  exposes getOpenPositions; live adapters don't, so this returns 0 there. */
  private lookupLiqPrice(orderId: string): number {
    const adapter = this.adapter as any;
    if (typeof adapter.getOpenPositions === 'function') {
      const pos = adapter.getOpenPositions().find((p: any) => p.orderId === orderId);
      if (pos && Number.isFinite(pos.liqPrice)) return pos.liqPrice;
    }
    return 0;
  }

  private publishRejected(p: OrderRequestedPayload | OrderValidatedPayload, reason: string, ts: number): void {
    this.eventBus.publish({
      id: `order-rej-${p.symbol}-${ts}-${this.seq}`,
      type: 'execution.order.rejected',
      ts,
      source: `execution:${this.adapter.name}`,
      symbol: p.symbol,
      payload: { reason, requested: p },
    });
  }
}
