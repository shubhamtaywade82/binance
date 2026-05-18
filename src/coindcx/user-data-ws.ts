import crypto from 'crypto';
import io from 'socket.io-client';
import type { EventBus } from '../core/events/event-bus';
import type { AppLogger } from '../logging/app-logger';
import { marketClock } from '../core/time/market-clock';
import { normalizeSymbol } from '../mapping/symbol-normalize';

/**
 * CoinDcxUserDataWs — authenticated socket.io v2.4 stream for user account.
 *
 * Channels subscribed:
 *   position_update   — opens / qty changes / closes
 *   order_update      — order acks, fills, cancels
 *   balance_update    — wallet balance changes
 *   new_trade         — fills with PnL (incl. realised)
 *
 * Each event is translated to a defaultEventBus DomainEvent so the rest of
 * the pipeline (EventToPostgresBridge, dashboard broadcast, RiskEngine
 * exposure tracking) is identical to paper mode.
 *
 * Heartbeat: socket.io's built-in ping. On disconnect, automatically
 * reconnects with fresh signed query. LiveAccountPoller stays running as
 * the REST fallback whenever this stream is offline > `pollWhenOfflineMs`.
 */
export interface CoinDcxUserDataWsOptions {
  apiKey: string;
  apiSecret: string;
  /** Default https://stream.coindcx.com */
  url?: string;
  log: AppLogger;
  eventBus: EventBus;
  /** Notified when WS is connected/disconnected — used to throttle the REST poll fallback. */
  onConnectionChange?: (connected: boolean) => void;
  /** Called on balance_update — caller usually triggers an immediate REST equity refresh. */
  onBalanceDelta?: () => void;
}

const DEFAULT_URL = 'https://stream.coindcx.com';

export class CoinDcxUserDataWs {
  private socket: ReturnType<typeof io> | null = null;
  private seq = 0;
  private stopped = false;
  /**
   * H-3: dedupe / track active position quantity per orderId so we only
   * publish `execution.order.filled` when the position *increases* (open or
   * pyramid add). Subsequent position_update events from mark-price moves or
   * partial closes carry the same orderId and would otherwise be aggregated
   * by RiskEngine as fresh fills.
   */
  private readonly lastActiveByOrder = new Map<string, number>();

  constructor(private readonly opts: CoinDcxUserDataWsOptions) {}

  start(): void {
    if (this.socket) return;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  private connect(): void {
    const timestamp = Math.floor(Date.now());
    const payload = JSON.stringify({ timestamp });
    const signature = crypto.createHmac('sha256', this.opts.apiSecret).update(payload).digest('hex');
    const url = this.opts.url ?? DEFAULT_URL;

    this.socket = io(url, {
      transports: ['websocket'],
      query: { auth_token: this.opts.apiKey, signature, timestamp: String(timestamp) },
      // socket.io v2 reconnection
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      timeout: 15_000,
    });

    this.socket.on('connect', () => {
      this.opts.log.info('coindcx_userdata_ws_connected', { url });
      this.opts.onConnectionChange?.(true);
      this.subscribe();
    });
    this.socket.on('disconnect', (reason: string) => {
      this.opts.log.warn('coindcx_userdata_ws_disconnected', { reason });
      this.opts.onConnectionChange?.(false);
      if (!this.stopped) {
        // socket.io reconnect handles auto-retry; signature TTL may expire so
        // force a fresh handshake periodically.
        setTimeout(() => this.refresh(), 5_000);
      }
    });
    this.socket.on('connect_error', (err: Error) => {
      this.opts.log.warn('coindcx_userdata_ws_connect_error', { err: err.message });
    });

    this.socket.on('position_update', (data: any) => this.onPosition(data));
    this.socket.on('order_update', (data: any) => this.onOrder(data));
    this.socket.on('balance_update', (data: any) => this.onBalance(data));
    this.socket.on('new_trade', (data: any) => this.onTrade(data));
  }

  private subscribe(): void {
    if (!this.socket) return;
    this.socket.emit('subscribe', {
      channels: ['position_update', 'order_update', 'balance_update', 'new_trade'],
    });
  }

  private refresh(): void {
    if (this.stopped || !this.socket) return;
    try { this.socket.disconnect(); } catch { /* ignore */ }
    this.socket = null;
    this.connect();
  }

  private onPosition(data: any): void {
    const rawSymbol = data?.pair ?? data?.symbol;
    if (!rawSymbol) return;
    // Canonicalise at the bus boundary so downstream consumers (RiskEngine,
    // exit managers) match by the same key the rest of the system uses.
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return;
    const side = (data?.side === 'buy' || data?.side === 'LONG') ? 'LONG' : 'SHORT';
    const ts = marketClock.now();
    const orderId = String(data?.position_id ?? data?.id ?? '');
    const active = Number(data?.active_pos ?? data?.quantity ?? 0);

    if (active > 0) {
      // H-3: only publish a fill when the active quantity INCREASED vs the
      // last seen value for this orderId. CoinDCX sends position_update on
      // every mark-price tick + on partial closes; without this guard each
      // tick re-runs RiskEngine.onFilled and balloons in-memory notional.
      const lastActive = this.lastActiveByOrder.get(orderId) ?? 0;
      if (active > lastActive) {
        const delta = active - lastActive;
        this.lastActiveByOrder.set(orderId, active);
        this.opts.eventBus.publish({
          id: `coindcx-pos-${orderId}-${ts}-${++this.seq}`,
          type: 'execution.order.filled',
          ts,
          source: 'coindcx-userdata-ws',
          symbol,
          payload: {
            orderId,
            symbol,
            side,
            // Publish the delta when this is a pyramid add; on first open
            // (lastActive=0) delta equals the full active size.
            quantity: delta,
            price: Number(data?.avg_price ?? data?.entry_price ?? 0),
            leverage: Number(data?.leverage ?? 0),
            marginUsdt: Number(data?.user_margin ?? 0),
            liqPrice: Number(data?.liquidation_price ?? 0),
            openedAt: Number(data?.created_at ?? ts),
          },
        });
      } else {
        // Position update with no qty increase = mark move or partial close.
        // Update the watermark in case it decreased (partial close) so a
        // subsequent re-add publishes correctly.
        this.lastActiveByOrder.set(orderId, active);
      }
    } else {
      this.lastActiveByOrder.delete(orderId);
      this.opts.eventBus.publish({
        id: `coindcx-pos-close-${orderId}-${ts}-${++this.seq}`,
        type: 'execution.position.closed',
        ts,
        source: 'coindcx-userdata-ws',
        symbol,
        payload: {
          orderId,
          symbol,
          side,
          reason: 'EXCHANGE_CLOSE',
          entryPrice: Number(data?.avg_price ?? 0),
          exitPrice: Number(data?.avg_close_price ?? data?.mark_price ?? 0),
          quantity: Number(data?.total_quantity ?? data?.closed_quantity ?? 0),
          netUsdt: Number(data?.pnl ?? 0),
          feesUsdt: Number(data?.fees ?? 0),
          fundingUsdt: 0,
          grossUsdt: Number(data?.pnl ?? 0) + Number(data?.fees ?? 0),
          openedAt: Number(data?.created_at ?? 0),
          closedAt: ts,
        },
      });
    }
  }

  private onOrder(data: any): void {
    const status = String(data?.status ?? '').toLowerCase();
    const ts = marketClock.now();
    let type = 'execution.order.submitted';
    if (status === 'filled' || status === 'closed') type = 'execution.order.filled';
    else if (status === 'cancelled' || status === 'rejected') type = 'execution.order.rejected';
    const symbol = normalizeSymbol(data?.pair);
    this.opts.eventBus.publish({
      id: `coindcx-order-${data?.id ?? ts}-${++this.seq}`,
      type,
      ts,
      source: 'coindcx-userdata-ws',
      symbol,
      payload: {
        orderId: String(data?.id ?? ''),
        symbol,
        side: data?.side === 'buy' ? 'LONG' : 'SHORT',
        quantity: Number(data?.total_quantity ?? 0),
        price: Number(data?.price ?? data?.avg_price ?? 0),
        status,
        feeUsdt: Number(data?.fee ?? 0),
      },
    });
  }

  private onBalance(data: any): void {
    const ts = marketClock.now();
    // CoinDCX sends per-currency balance; we re-aggregate downstream.
    this.opts.eventBus.publish({
      id: `coindcx-balance-${ts}-${++this.seq}`,
      type: 'wallet.delta',
      ts,
      source: 'coindcx-userdata-ws',
      payload: { ...data, mode: 'live' },
    });
    // Trigger an immediate REST fetch so the equity broadcast (which is the
    // aggregate the dashboard renders) reflects the new balance within ~200ms.
    this.opts.onBalanceDelta?.();
  }

  private onTrade(data: any): void {
    // Fill confirmation w/ realised PnL on closes. Pipe to event bus so
    // EventToPostgresBridge can update orders/trades tables.
    const ts = marketClock.now();
    this.opts.eventBus.publish({
      id: `coindcx-fill-${data?.id ?? ts}-${++this.seq}`,
      type: 'execution.order.fill',
      ts,
      source: 'coindcx-userdata-ws',
      symbol: normalizeSymbol(data?.pair),
      payload: { ...data, mode: 'live' },
    });
  }
}
