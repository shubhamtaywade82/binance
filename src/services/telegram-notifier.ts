import axios from 'axios';
import { DomainEvent, SignalPayload } from '@coindcx/contracts';
import { AppConfig } from '../config';
import { EventBus } from '../core/events/event-bus';

/**
 * Professional Telegram alert system for the AI Trader.
 * Subscribes to the central EventBus and sends formatted Markdown messages
 * to a configured Telegram bot/chat.
 */
export class TelegramNotifier {
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;

  constructor(
    cfg: AppConfig,
    private readonly eventBus: EventBus,
  ) {
    this.token = cfg.TELEGRAM_BOT_TOKEN;
    this.chatId = cfg.TELEGRAM_CHAT_ID;
  }

  /**
   * Initialize subscriptions. Only wires up if token and chatId are present.
   */
  public init(): void {
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
    
    console.log('[TelegramNotifier] Subscriptions initialized');
    
    // Initial status message
    this.sendRawMessage('🤖 *AI Trader System Online*\nTelegram alerts enabled.').catch(() => {});
  }

  private async onOrderFilled(event: DomainEvent<any>): Promise<void> {
    console.log('[TelegramNotifier] Received order.filled:', event.symbol);
    const { symbol, payload } = event;
    const { side, price, quantity, strategyId } = payload;
    const emoji = side === 'BUY' ? '🟢' : '🔴';
    
    const message = [
      `📦 *Order Filled* ${emoji}`,
      `*Symbol*: \`${symbol}\``,
      `*Side*: ${side}`,
      `*Price*: \`${price}\``,
      `*Qty*: \`${quantity}\``,
      strategyId ? `*Strategy*: \`${strategyId}\`` : '',
    ].filter(Boolean).join('\n');

    await this.sendRawMessage(message);
  }

  private async onOrderRejected(event: DomainEvent<any>): Promise<void> {
    console.log('[TelegramNotifier] Received order.rejected:', event.symbol);
    const { symbol, payload } = event;
    const { reason, side, quantity } = payload;
    
    const message = [
      `❌ *Order Rejected*`,
      `*Symbol*: \`${symbol}\``,
      `*Side*: ${side}`,
      `*Qty*: \`${quantity}\``,
      `*Reason*: ${reason}`,
    ].join('\n');

    await this.sendRawMessage(message);
  }

  private async onPositionClosed(event: DomainEvent<any>): Promise<void> {
    console.log('[TelegramNotifier] Received position.closed:', event.symbol);
    const { symbol, payload } = event;
    const { pnl, pnlPct } = payload;
    const emoji = (pnl || 0) >= 0 ? '💰' : '📉';
    
    const message = [
      `${emoji} *Position Closed*`,
      `*Symbol*: \`${symbol}\``,
      `*PnL*: \`${pnl?.toFixed(2)}\` USDT (${((pnlPct || 0) * 100).toFixed(2)}%)`,
    ].join('\n');

    await this.sendRawMessage(message);
  }

  private async onStrategySignal(event: DomainEvent<SignalPayload>): Promise<void> {
    console.log('[TelegramNotifier] Received strategy.signal:', event.symbol, event.payload.signal);
    const { symbol, payload } = event;
    const { signal, confidence, metadata } = payload;
    if (signal === 'FLAT') return;

    const comment = metadata?.comment as string | undefined;
    const emoji = signal === 'LONG' ? '📈' : '📉';
    const message = [
      `${emoji} *New Strategy Signal*`,
      `*Symbol*: \`${symbol}\``,
      `*Direction*: ${signal}`,
      `*Confidence*: \`${((confidence || 0) * 100).toFixed(1)}%\``,
      comment ? `*Note*: ${comment}` : '',
    ].filter(Boolean).join('\n');

    await this.sendRawMessage(message);
  }

  private async onOrderSubmitted(event: DomainEvent<any>): Promise<void> {
    console.log('[TelegramNotifier] Received order.submitted:', event.symbol);
    const { symbol, payload } = event;
    const { side, quantity, price, type } = payload;
    
    const message = [
      `📝 *Order Submitted*`,
      `*Symbol*: \`${symbol}\``,
      `*Side*: ${side}`,
      `*Qty*: \`${quantity}\``,
      price ? `*Price*: \`${price}\`` : '',
      `*Type*: ${type}`,
    ].filter(Boolean).join('\n');

    await this.sendRawMessage(message);
  }

  private async onTrailUpdate(event: DomainEvent<any>): Promise<void> {
    console.log('[TelegramNotifier] Received trail.update:', event.symbol);
    const { symbol, payload } = event;
    const { trailPrice, side } = payload;
    
    const message = [
      `🛡️ *Trailing Stop Updated*`,
      `*Symbol*: \`${symbol}\``,
      `*New SL*: \`${trailPrice?.toFixed(5)}\` (${side})`,
    ].join('\n');

    await this.sendRawMessage(message);
  }

  private async onWalletUpdate(event: DomainEvent<any>): Promise<void> {
    console.log('[TelegramNotifier] Received wallet.update');
    const { payload } = event;
    const { totalWalletBalance, totalUnrealizedProfit } = payload;
    if (totalWalletBalance === undefined) return;

    const message = [
      `💳 *Wallet Update*`,
      `*Balance*: \`${totalWalletBalance?.toFixed(2)}\` USDT`,
      `*Unrealized PnL*: \`${totalUnrealizedProfit?.toFixed(2)}\` USDT`,
    ].join('\n');

    await this.sendRawMessage(message);
  }

  private async onAiBrief(event: DomainEvent<any>): Promise<void> {
    const { symbol, payload } = event;
    const { text } = payload;
    
    const message = [
      `🤖 *AI Market Brief*`,
      `*Symbol*: \`${symbol}\``,
      '',
      text,
    ].join('\n');

    await this.sendRawMessage(message);
  }

  /**
   * Send a raw markdown message to Telegram.
   */
  public async sendRawMessage(text: string): Promise<void> {
    if (!this.token || !this.chatId) return;

    try {
      const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
      await axios.post(url, {
        chat_id: this.chatId,
        text,
        parse_mode: 'Markdown',
      }, {
        timeout: 5000,
      });
    } catch (err: any) {
      // Don't crash the app if Telegram fails. 
      // Log as error but continue execution.
      console.error('[TelegramNotifier] Failed to send message:', err.message);
    }
  }
}
