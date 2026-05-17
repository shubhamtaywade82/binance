import axios from 'axios';
import { DomainEvent, SignalPayload } from '@coindcx/contracts';
import { AppConfig } from '../config';
import { EventBus } from '../core/events/event-bus';
import { AppLogger } from '../logging/app-logger';

/**
 * Professional Telegram alert system for the AI Trader.
 * Subscribes to the central EventBus and sends formatted HTML messages
 * to a configured Telegram bot/chat.
 */
export class TelegramNotifier {
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;

  constructor(
    cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly log: AppLogger,
  ) {
    this.token = cfg.TELEGRAM_BOT_TOKEN;
    this.chatId = cfg.TELEGRAM_CHAT_ID;
  }

  /**
   * Starts the notifier and initializes subscriptions.
   */
  public start(): void {
    if (!this.token || !this.chatId) {
      return;
    }

    this.eventBus.subscribe<any>('execution.order.filled', (e) => this.onOrderFilled(e));
    this.eventBus.subscribe<any>('execution.order.rejected', (e) => this.onOrderRejected(e));
    this.eventBus.subscribe<any>('execution.position.closed', (e) => this.onPositionClosed(e));
    this.eventBus.subscribe<any>('strategy.signal', (e) => this.onStrategySignal(e));
    this.eventBus.subscribe<any>('ai.market.brief', (e) => this.onAiBrief(e));
    this.eventBus.subscribe<any>('trail.update', (e) => this.onTrailUpdate(e));
    this.eventBus.subscribe<any>('wallet.update', (e) => this.onWalletUpdate(e));
    this.eventBus.subscribe<any>('execution.order.submitted', (e) => this.onOrderSubmitted(e));
    
    this.log.info('telegram_notifier_started', { chatId: this.chatId });
    
    // Initial status message
    void this.sendRawMessage('🤖 <b>AI Trader System Online</b>\nTelegram alerts enabled.');
  }

  private async onOrderFilled(event: DomainEvent<any>): Promise<void> {
    this.log.info('telegram_alert_order_filled', { symbol: event.symbol });
    const { symbol, payload } = event;
    const { side, price, quantity, strategyId } = payload;
    const emoji = side === 'BUY' ? '🟢' : '🔴';
    
    const message = [
      `📦 <b>Order Filled</b> ${emoji}`,
      `<b>Symbol</b>: <code>${symbol}</code>`,
      `<b>Side</b>: ${side}`,
      `<b>Price</b>: <code>${price}</code>`,
      `<b>Qty</b>: <code>${quantity}</code>`,
      strategyId ? `<b>Strategy</b>: <code>${strategyId}</code>` : '',
    ].filter(Boolean).join('\n');

    void this.sendRawMessage(message);
  }

  private async onOrderRejected(event: DomainEvent<any>): Promise<void> {
    this.log.warn('telegram_alert_order_rejected', { symbol: event.symbol, reason: event.payload.reason });
    const { symbol, payload } = event;
    const { reason, side, quantity } = payload;
    
    const message = [
      `❌ <b>Order Rejected</b>`,
      `<b>Symbol</b>: <code>${symbol}</code>`,
      `<b>Side</b>: ${side}`,
      `<b>Qty</b>: <code>${quantity}</code>`,
      `<b>Reason</b>: ${reason}`,
    ].join('\n');

    void this.sendRawMessage(message);
  }

  private async onPositionClosed(event: DomainEvent<any>): Promise<void> {
    this.log.info('telegram_alert_position_closed', { symbol: event.symbol, pnl: event.payload.pnl });
    const { symbol, payload } = event;
    const { pnl, pnlPct } = payload;
    const emoji = (pnl || 0) >= 0 ? '💰' : '📉';
    
    const message = [
      `${emoji} <b>Position Closed</b>`,
      `<b>Symbol</b>: <code>${symbol}</code>`,
      `<b>PnL</b>: <code>${pnl?.toFixed(2)}</code> USDT (${((pnlPct || 0) * 100).toFixed(2)}%)`,
    ].join('\n');

    void this.sendRawMessage(message);
  }

  private async onStrategySignal(event: DomainEvent<SignalPayload>): Promise<void> {
    const { symbol, payload } = event;
    const { signal, confidence, metadata } = payload;
    if (signal === 'FLAT') return;

    this.log.info('telegram_alert_strategy_signal', { symbol, signal, confidence });
    const comment = metadata?.comment as string | undefined;
    const emoji = signal === 'LONG' ? '📈' : '📉';
    const message = [
      `${emoji} <b>New Strategy Signal</b>`,
      `<b>Symbol</b>: <code>${symbol}</code>`,
      `<b>Direction</b>: ${signal}`,
      `<b>Confidence</b>: <code>${((confidence || 0) * 100).toFixed(1)}%</code>`,
      comment ? `<b>Note</b>: ${comment}` : '',
    ].filter(Boolean).join('\n');

    void this.sendRawMessage(message);
  }

  private async onOrderSubmitted(event: DomainEvent<any>): Promise<void> {
    const { symbol, payload } = event;
    const { side, quantity, price, type } = payload;
    
    const message = [
      `📝 <b>Order Submitted</b>`,
      `<b>Symbol</b>: <code>${symbol}</code>`,
      `<b>Side</b>: ${side}`,
      `<b>Qty</b>: <code>${quantity}</code>`,
      price ? `<b>Price</b>: <code>${price}</code>` : '',
      `<b>Type</b>: ${type}`,
    ].filter(Boolean).join('\n');

    void this.sendRawMessage(message);
  }

  private async onTrailUpdate(event: DomainEvent<any>): Promise<void> {
    const { symbol, payload } = event;
    const { trailPrice, side } = payload;
    
    const message = [
      `🛡️ <b>Trailing Stop Updated</b>`,
      `<b>Symbol</b>: <code>${symbol}</code>`,
      `<b>New SL</b>: <code>${trailPrice?.toFixed(5)}</code> (${side})`,
    ].join('\n');

    void this.sendRawMessage(message);
  }

  private async onWalletUpdate(event: DomainEvent<any>): Promise<void> {
    const { payload } = event;
    const { totalWalletBalance, totalUnrealizedProfit } = payload;
    if (totalWalletBalance === undefined) return;

    const message = [
      `💳 <b>Wallet Update</b>`,
      `<b>Balance</b>: <code>${totalWalletBalance?.toFixed(2)}</code> USDT`,
      `<b>Unrealized PnL</b>: <code>${totalUnrealizedProfit?.toFixed(2)}</code> USDT`,
    ].join('\n');

    void this.sendRawMessage(message);
  }

  private async onAiBrief(event: DomainEvent<any>): Promise<void> {
    const { symbol, payload } = event;
    const { text } = payload;
    
    const message = [
      `🤖 <b>AI Market Brief</b>`,
      `<b>Symbol</b>: <code>${symbol}</code>`,
      '',
      text,
    ].join('\n');

    void this.sendRawMessage(message);
  }

  /**
   * Send a raw HTML message to Telegram.
   */
  public async sendRawMessage(text: string): Promise<void> {
    if (!this.token || !this.chatId) return;

    try {
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
      }, {
        timeout: 5000,
      });
    } catch (err: any) {
      this.log.error('telegram_notifier_send_failed', { err: err.message });
    }
  }
}
