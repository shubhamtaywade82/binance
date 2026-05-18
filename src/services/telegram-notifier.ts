import axios from 'axios';
import { DomainEvent, SignalPayload } from '@coindcx/contracts';
import { AppConfig } from '../config';
import { EventBus } from '../core/events/event-bus';
import { AppLogger } from '../logging/app-logger';

/**
 * TelegramNotifier — professional alert pipeline driven by the event bus.
 *
 *   Categories (filter via TELEGRAM_ALERT_LEVELS comma-list):
 *     critical   — rejections, liquidations, kill-switch
 *     trade      — entries, exits, partial TPs (default loud)
 *     signal     — strategy.signal emits (regime, confidence)
 *     trail      — trailing-stop moves (rate-limited per symbol)
 *     wallet     — equity / drawdown changes (rate-limited)
 *     ai         — AI market briefs + periodic digests
 *     system     — startup / shutdown / WS reconnects
 *
 * Built-in safeguards:
 *   - Token bucket (TELEGRAM_RATE_PER_MIN, default 20) to stay under
 *     Telegram's 30 msgs/sec/chat ceiling.
 *   - Per-symbol throttle on trail.update (TELEGRAM_TRAIL_THROTTLE_SEC).
 *   - Wallet throttle: only emit when equity moves > TELEGRAM_WALLET_DELTA_PCT
 *     OR TELEGRAM_WALLET_INTERVAL_MIN elapsed since last push.
 *   - Periodic digest every TELEGRAM_DIGEST_INTERVAL_MIN (PnL + open positions).
 *
 * Public API surfaces a `sendRawMessage()` so other subsystems (Postgres
 * ingest checks, ML drift alerts) can pipe in too.
 */

export type AlertCategory = 'critical' | 'trade' | 'signal' | 'trail' | 'wallet' | 'ai' | 'system';

const DEFAULT_LEVELS: AlertCategory[] = ['critical', 'trade', 'signal', 'ai', 'system'];

interface TelegramConfig {
  token?: string;
  chatId?: string;
  levels: Set<AlertCategory>;
  ratePerMin: number;
  trailThrottleSec: number;
  walletDeltaPct: number;
  walletIntervalMin: number;
  digestIntervalMin: number;
  parseMode: 'HTML' | 'MarkdownV2';
}

export class TelegramNotifier {
  private readonly cfg: TelegramConfig;
  private bucketTokens: number;
  private lastBucketRefill = Date.now();
  private readonly lastTrailEmit = new Map<string, number>();
  private lastWalletEmitTs = 0;
  private lastWalletEquity: number | null = null;
  private digestTimer: ReturnType<typeof setInterval> | null = null;
  private tradesSinceDigest = { wins: 0, losses: 0, grossPnl: 0 };
  private startedAt = Date.now();

  constructor(
    cfg: AppConfig,
    private readonly eventBus: EventBus,
    private readonly log: AppLogger,
  ) {
    const lvlRaw = String((cfg as any).TELEGRAM_ALERT_LEVELS ?? '').trim();
    const levels = lvlRaw
      ? new Set(lvlRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) as AlertCategory[])
      : new Set<AlertCategory>(DEFAULT_LEVELS);

    this.cfg = {
      token: cfg.TELEGRAM_BOT_TOKEN,
      chatId: cfg.TELEGRAM_CHAT_ID,
      levels,
      ratePerMin: Number((cfg as any).TELEGRAM_RATE_PER_MIN) || 20,
      trailThrottleSec: Number((cfg as any).TELEGRAM_TRAIL_THROTTLE_SEC) || 300,
      walletDeltaPct: Number((cfg as any).TELEGRAM_WALLET_DELTA_PCT) || 0.02,
      walletIntervalMin: Number((cfg as any).TELEGRAM_WALLET_INTERVAL_MIN) || 30,
      digestIntervalMin: Number((cfg as any).TELEGRAM_DIGEST_INTERVAL_MIN) || 360,
      parseMode: 'HTML',
    };
    this.bucketTokens = this.cfg.ratePerMin;
  }

  public start(): void {
    if (!this.cfg.token || !this.cfg.chatId) {
      this.log.info('telegram_notifier_disabled', { reason: 'missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID' });
      return;
    }

    // C-4: every Telegram dispatch is an HTTPS call. Use subscribeAsync so a
    // slow Telegram API never back-pressures kline ingestion or order
    // routing. Per-subscriber queue absorbs short stalls; repeated failures
    // dead-letter the message so a single malformed payload doesn't lock
    // the channel.
    const opts = { name: 'telegram-notifier', queueWarnThreshold: 50, maxConsecutiveErrors: 3 };

    // Trade lifecycle
    this.eventBus.subscribeAsync<any>('execution.order.filled', (e) => this.onOrderFilled(e), opts);
    this.eventBus.subscribeAsync<any>('execution.order.rejected', (e) => this.onOrderRejected(e), opts);
    this.eventBus.subscribeAsync<any>('execution.position.closed', (e) => this.onPositionClosed(e), opts);
    this.eventBus.subscribeAsync<any>('execution.order.submitted', (e) => this.onOrderSubmitted(e), opts);

    // Strategy
    this.eventBus.subscribeAsync<any>('strategy.signal', (e) => this.onStrategySignal(e), opts);
    this.eventBus.subscribeAsync<any>('trail.update', (e) => this.onTrailUpdate(e), opts);

    // Account
    this.eventBus.subscribeAsync<any>('wallet.update', (e) => this.onWalletUpdate(e), opts);

    // AI
    this.eventBus.subscribeAsync<any>('ai.market.brief', (e) => this.onAiBrief(e), opts);

    // System / risk
    this.eventBus.subscribeAsync<any>('system.killswitch', (e) => this.onKillSwitch(e), opts);
    this.eventBus.subscribeAsync<any>('risk.drawdown', (e) => this.onDrawdown(e), opts);

    // Periodic digest
    if (this.cfg.digestIntervalMin > 0) {
      this.digestTimer = setInterval(() => void this.sendDigest(), this.cfg.digestIntervalMin * 60_000);
    }

    this.log.info('telegram_notifier_started', {
      chatId: this.cfg.chatId,
      levels: [...this.cfg.levels],
      ratePerMin: this.cfg.ratePerMin,
    });
    void this.sendCategory('system',
      `🤖 <b>AI Trader Online</b>\nMode: <code>live | paper</code>\n` +
      `Alerts: <code>${[...this.cfg.levels].join(', ')}</code>\n` +
      `Digest every <b>${this.cfg.digestIntervalMin}m</b>`,
    );
  }

  public stop(): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = null;
  }

  // ── handlers ─────────────────────────────────────────────────────────────

  private onOrderFilled(event: DomainEvent<any>): void {
    const { symbol, payload } = event;
    const side = payload.side || (payload.payload?.side);
    const emoji = side === 'LONG' || side === 'BUY' ? '🟢' : '🔴';
    const px = fmt(payload.price);
    const qty = fmt(payload.quantity);
    const lev = payload.leverage ? `${payload.leverage}x` : '';
    const reason = payload.reason ? `· ${payload.reason}` : '';
    const strat = payload.strategyId ? `\n<i>${escape(payload.strategyId)}</i>` : '';
    void this.sendCategory('trade',
      `${emoji} <b>${escape(symbol ?? '?')}</b> ${side} ${lev} ${reason}\n` +
      `Entry <code>${px}</code> · Qty <code>${qty}</code>${strat}`,
    );
  }

  private onOrderRejected(event: DomainEvent<any>): void {
    const reason = event.payload?.reason ?? 'UNKNOWN';
    const req = event.payload?.requested ?? {};
    void this.sendCategory('critical',
      `⚠️ <b>Order Rejected</b>\n` +
      `${escape(req.symbol ?? event.symbol ?? '?')} ${req.side ?? ''} qty <code>${fmt(req.quantity)}</code>\n` +
      `Reason: <code>${escape(reason)}</code>`,
    );
  }

  private onPositionClosed(event: DomainEvent<any>): void {
    const { symbol, payload } = event;
    const net = Number(payload.netUsdt ?? payload.pnl ?? 0);
    const entry = Number(payload.entryPrice);
    const exit = Number(payload.exitPrice);
    const pct = entry > 0 ? ((exit - entry) / entry) * (payload.side === 'SHORT' ? -1 : 1) * 100 : 0;
    const emoji = net >= 0 ? '💰' : '📉';
    const reason = payload.reason ?? 'CLOSED';

    if (net >= 0) this.tradesSinceDigest.wins++;
    else this.tradesSinceDigest.losses++;
    this.tradesSinceDigest.grossPnl += net;

    void this.sendCategory('trade',
      `${emoji} <b>${escape(symbol ?? '?')}</b> Closed · ${escape(reason)}\n` +
      `<code>${fmt(entry)} → ${fmt(exit)}</code> (${pct.toFixed(2)}%)\n` +
      `Net: <b>${net.toFixed(2)} USDT</b>`,
    );
  }

  private onOrderSubmitted(event: DomainEvent<any>): void {
    // Optional — silent by default to avoid duplicate-with-filled noise.
    if (!this.cfg.levels.has('signal')) return;
    const { symbol, payload } = event;
    void this.sendCategory('signal',
      `📝 Submitting <b>${escape(symbol ?? '?')}</b> ${payload.side ?? ''} ` +
      `qty <code>${fmt(payload.quantity)}</code> @ <code>${fmt(payload.price)}</code>`,
    );
  }

  private onStrategySignal(event: DomainEvent<SignalPayload>): void {
    const { symbol, payload } = event;
    if (payload.signal === 'FLAT') return;
    const conf = Math.round((payload.confidence ?? 0) * 100);
    const arrow = payload.signal === 'LONG' ? '📈' : '📉';
    const meta = payload.metadata as any;
    const regime = meta?.regime ? ` · <i>${escape(meta.regime)}</i>` : '';
    void this.sendCategory('signal',
      `${arrow} <b>${escape(symbol ?? '?')}</b> ${payload.signal}${regime}\n` +
      `Confidence: <code>${conf}%</code>${meta?.comment ? '\n' + escape(meta.comment) : ''}`,
    );
  }

  private onTrailUpdate(event: DomainEvent<any>): void {
    const sym = event.symbol ?? '?';
    const now = Date.now();
    const last = this.lastTrailEmit.get(sym) ?? 0;
    if (now - last < this.cfg.trailThrottleSec * 1000) return;
    this.lastTrailEmit.set(sym, now);

    const p = event.payload;
    const trail = fmt(p.currentTrail);
    const entry = fmt(p.entry);
    void this.sendCategory('trail',
      `🛡️ <b>${escape(sym)}</b> Trail updated\n` +
      `Entry <code>${entry}</code> → Stop <code>${trail}</code>`,
    );
  }

  private onWalletUpdate(event: DomainEvent<any>): void {
    const p = event.payload;
    const equity = Number(p.equityUsdt ?? p.totalWalletBalance ?? 0);
    if (equity <= 0) return;
    const now = Date.now();

    const prev = this.lastWalletEquity ?? equity;
    const deltaPct = prev > 0 ? Math.abs(equity - prev) / prev : 0;
    const intervalElapsed = now - this.lastWalletEmitTs >= this.cfg.walletIntervalMin * 60_000;
    if (deltaPct < this.cfg.walletDeltaPct && !intervalElapsed) return;

    this.lastWalletEmitTs = now;
    this.lastWalletEquity = equity;

    const upnl = Number(p.unrealizedPnlUsdt ?? p.totalUnrealizedProfit ?? 0);
    const rpnl = Number(p.realizedPnlUsdt ?? 0);
    void this.sendCategory('wallet',
      `💳 <b>Wallet</b>\n` +
      `Equity <code>${equity.toFixed(2)}</code> USDT\n` +
      `Unrealized <code>${upnl.toFixed(2)}</code> · Realized <code>${rpnl.toFixed(2)}</code>`,
    );
  }

  private onAiBrief(event: DomainEvent<any>): void {
    const { symbol, payload } = event;
    const text = String(payload?.text ?? '').slice(0, 3500);
    if (!text) return;
    void this.sendCategory('ai',
      `🤖 <b>AI Brief</b> · ${escape(symbol ?? '*')}\n\n${mdToHtml(text)}`,
    );
  }

  private onKillSwitch(event: DomainEvent<any>): void {
    void this.sendCategory('critical',
      `🚨 <b>KILL SWITCH</b>\nReason: <code>${escape(event.payload?.reason ?? 'manual')}</code>`,
    );
  }

  private onDrawdown(event: DomainEvent<any>): void {
    const pct = Number(event.payload?.drawdownPct ?? 0);
    void this.sendCategory('critical',
      `🩸 <b>Drawdown ${pct.toFixed(2)}%</b>\n` +
      `Threshold breached — review positions.`,
    );
  }

  // ── digest ───────────────────────────────────────────────────────────────

  private async sendDigest(): Promise<void> {
    const win = this.tradesSinceDigest.wins;
    const loss = this.tradesSinceDigest.losses;
    const total = win + loss;
    const pnl = this.tradesSinceDigest.grossPnl;
    const winRate = total > 0 ? (win / total) * 100 : 0;
    const uptimeMin = Math.round((Date.now() - this.startedAt) / 60_000);
    const period = this.cfg.digestIntervalMin;

    const text = [
      `📊 <b>${period}m Digest</b>`,
      `Trades: <b>${total}</b> · W/L <code>${win}/${loss}</code> (${winRate.toFixed(0)}%)`,
      `Net PnL: <b>${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}</b> USDT`,
      `Uptime: <code>${uptimeMin}m</code>`,
    ].join('\n');

    this.tradesSinceDigest = { wins: 0, losses: 0, grossPnl: 0 };
    void this.sendCategory('ai', text);
  }

  // ── core: rate-limited send + category gating ───────────────────────────

  public async sendCategory(cat: AlertCategory, text: string): Promise<void> {
    if (!this.cfg.levels.has(cat)) return;
    if (!this.consumeToken()) {
      this.log.warn('telegram_rate_limited', { category: cat });
      return;
    }
    await this.sendRawMessage(text);
  }

  public async sendRawMessage(text: string): Promise<void> {
    if (!this.cfg.token || !this.cfg.chatId) return;
    try {
      const url = `https://api.telegram.org/bot${this.cfg.token}/sendMessage`;
      await axios.post(url, {
        chat_id: this.cfg.chatId,
        text,
        parse_mode: this.cfg.parseMode,
        disable_web_page_preview: true,
      }, { timeout: 5000 });
    } catch (err: any) {
      this.log.warn('telegram_notifier_send_failed', { err: err?.message });
    }
  }

  private consumeToken(): boolean {
    const now = Date.now();
    const elapsedMs = now - this.lastBucketRefill;
    if (elapsedMs >= 60_000) {
      this.bucketTokens = this.cfg.ratePerMin;
      this.lastBucketRefill = now;
    } else {
      const refill = (elapsedMs / 60_000) * this.cfg.ratePerMin;
      this.bucketTokens = Math.min(this.cfg.ratePerMin, this.bucketTokens + refill);
      this.lastBucketRefill = now;
    }
    if (this.bucketTokens < 1) return false;
    this.bucketTokens -= 1;
    return true;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const fmt = (v: any): string => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(6);
};

const escape = (s: string): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const mdToHtml = (s: string): string => {
  let t = escape(s);
  t = t.replace(/^#+\s+(.*)$/gm, (_, title) => {
    const cleanTitle = title.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1');
    return `<b><u>${cleanTitle}</u></b>`;
  });
  t = t.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
  t = t.replace(/\*([^\*\n]+)\*/g, '<i>$1</i>');
  t = t.replace(/^\s*-\s+/gm, '• ');
  return t;
};
