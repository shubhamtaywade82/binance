import { describe, expect, it, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { TelegramNotifier } from '../src/services/telegram-notifier';
import { EventBus } from '../src/core/events/event-bus';
import { AppConfig } from '../src/config';

vi.mock('axios');

describe('TelegramNotifier', () => {
  let eventBus: EventBus;
  let notifier: TelegramNotifier;
  const cfg = {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_CHAT_ID: 'test-chat-id',
  } as AppConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    eventBus = new EventBus();
    notifier = new TelegramNotifier(cfg, eventBus);
  });

  it('should send a welcome message on init', async () => {
    notifier.init();
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('test-token/sendMessage'),
      expect.objectContaining({
        chat_id: 'test-chat-id',
        text: expect.stringContaining('AI Trader System Online'),
      }),
      expect.any(Object)
    );
  });

  it('should send an alert on order filled', async () => {
    notifier.init();
    eventBus.publish({
      id: 'e1',
      type: 'execution.order.filled',
      ts: Date.now(),
      symbol: 'SOLUSDT',
      payload: {
        side: 'BUY',
        price: 145.2,
        quantity: 10,
        strategyId: 'SMC',
      },
    });

    // Wait for async call
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('Order Filled'),
      }),
      expect.any(Object)
    );
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('SOLUSDT'),
      }),
      expect.any(Object)
    );
  });

  it('should send an alert on strategy signal', async () => {
    notifier.init();
    eventBus.publish({
      id: 'e2',
      type: 'strategy.signal',
      ts: Date.now(),
      symbol: 'BTCUSDT',
      payload: {
        signal: 'LONG',
        confidence: 0.85,
        comment: 'Breakout',
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('New Strategy Signal'),
      }),
      expect.any(Object)
    );
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('BTCUSDT'),
      }),
      expect.any(Object)
    );
  });

  it('should send an alert on AI market brief', async () => {
    notifier.init();
    eventBus.publish({
      id: 'e4',
      type: 'ai.market.brief',
      ts: Date.now(),
      symbol: 'SOLUSDT',
      payload: {
        text: 'The market is looking bullish due to SMC breakout.',
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('AI Market Brief'),
      }),
      expect.any(Object)
    );
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('bullish'),
      }),
      expect.any(Object)
    );
  });

  it('should send an alert on trail update', async () => {
    notifier.init();
    eventBus.publish({
      id: 'e5',
      type: 'trail.update',
      ts: Date.now(),
      symbol: 'SOLUSDT',
      payload: {
        trailPrice: 150.5,
        side: 'LONG',
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('Trailing Stop Updated'),
      }),
      expect.any(Object)
    );
  });

  it('should send an alert on wallet update', async () => {
    notifier.init();
    eventBus.publish({
      id: 'e6',
      type: 'wallet.update',
      ts: Date.now(),
      payload: {
        totalWalletBalance: 10500.5,
        totalUnrealizedProfit: 120.3,
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('Wallet Update'),
      }),
      expect.any(Object)
    );
    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        text: expect.stringContaining('10500.5'),
      }),
      expect.any(Object)
    );
  });

  it('should gracefully handle axios errors', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('Network error'));
    notifier.init();
    
    // Should not throw
    eventBus.publish({
      id: 'e3',
      type: 'execution.order.filled',
      ts: Date.now(),
      symbol: 'ETHUSDT',
      payload: { side: 'SELL', price: 2500, quantity: 1 },
    });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(axios.post).toHaveBeenCalled();
  });
});
