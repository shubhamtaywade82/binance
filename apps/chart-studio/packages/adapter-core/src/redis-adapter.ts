import Redis from 'ioredis';
import type { MarketDataProvider, Unsub } from './provider';
import {
  ctrlTopic,
  dataTopic,
  discoverReqTopic,
  discoverRepTopic,
  presenceTopic,
  type CtrlMessage,
  type DiscoverRequest,
  type DiscoverReply,
  type PresenceMessage,
} from './topics';
import type { Channel, DataEnvelope } from './types';

interface RefCountedStream {
  unsub: Unsub;
  refs: number;
  /** Last snapshot frame, replayed for late subscribers. */
  lastSnapshot?: unknown;
}

export interface RedisAdapterOptions {
  redisUrl: string;
  presenceIntervalMs?: number;
}

/**
 * Base class for provider microservices. Subclass with a MarketDataProvider
 * implementation and call `start()` — wiring of Redis pub/sub is automatic.
 */
export class RedisAdapter {
  protected readonly sub: Redis;
  protected readonly pub: Redis;
  private readonly streams = new Map<string, RefCountedStream>();
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    protected readonly provider: MarketDataProvider,
    private readonly opts: RedisAdapterOptions,
  ) {
    this.sub = new Redis(opts.redisUrl);
    this.pub = new Redis(opts.redisUrl);
  }

  async start(): Promise<void> {
    await this.provider.init();

    this.sub.on('message', (channel, raw) => {
      if (channel === ctrlTopic(this.provider.id)) {
        this.handleCtrl(raw).catch((err) => console.error('[ctrl]', err));
      } else if (channel === discoverReqTopic(this.provider.id)) {
        this.handleDiscover(raw).catch((err) => console.error('[discover]', err));
      }
    });

    await this.sub.subscribe(ctrlTopic(this.provider.id), discoverReqTopic(this.provider.id));

    this.announcePresence('online');
    const interval = this.opts.presenceIntervalMs ?? 10_000;
    this.presenceTimer = setInterval(() => this.announcePresence('online'), interval);

    process.once('SIGTERM', () => void this.stop());
    process.once('SIGINT', () => void this.stop());
  }

  async stop(): Promise<void> {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.announcePresence('offline');
    for (const s of this.streams.values()) s.unsub();
    this.streams.clear();
    await this.provider.shutdown();
    await this.sub.quit();
    await this.pub.quit();
  }

  private announcePresence(state: 'online' | 'offline'): void {
    const msg: PresenceMessage = {
      provider: this.provider.id,
      displayName: this.provider.displayName,
      ts: Date.now(),
      state,
    };
    this.pub.publish(presenceTopic(this.provider.id), JSON.stringify(msg)).catch(() => {});
  }

  private streamKey(channel: Channel, symbol: string, key?: string): string {
    return `${channel}:${symbol.toUpperCase()}:${key ?? ''}`;
  }

  private async handleCtrl(raw: string): Promise<void> {
    let msg: CtrlMessage;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.op === 'sub') await this.subscribe(msg);
    else if (msg.op === 'unsub') this.unsubscribe(msg);
  }

  private async subscribe(msg: CtrlMessage): Promise<void> {
    const k = this.streamKey(msg.channel, msg.symbol, msg.key);
    const existing = this.streams.get(k);
    if (existing) {
      existing.refs += 1;
      if (existing.lastSnapshot !== undefined) {
        // Replay snapshot for the new subscriber.
        this.publishData({
          provider: this.provider.id,
          symbol: msg.symbol.toUpperCase(),
          channel: msg.channel,
          key: msg.key,
          kind: 'snapshot',
          ts: Date.now(),
          data: existing.lastSnapshot,
        });
      }
      return;
    }

    const stream = this.openStream(msg);
    this.streams.set(k, stream);
    await this.fetchAndPublishSnapshot(msg, k);
  }

  private unsubscribe(msg: CtrlMessage): void {
    const k = this.streamKey(msg.channel, msg.symbol, msg.key);
    const existing = this.streams.get(k);
    if (!existing) return;
    existing.refs -= 1;
    if (existing.refs <= 0) {
      existing.unsub();
      this.streams.delete(k);
    }
  }

  private openStream(msg: CtrlMessage): RefCountedStream {
    const publish = (data: unknown): void => {
      this.publishData({
        provider: this.provider.id,
        symbol: msg.symbol.toUpperCase(),
        channel: msg.channel,
        key: msg.key,
        kind: 'update',
        ts: Date.now(),
        data,
      });
    };

    let unsub: Unsub;
    switch (msg.channel) {
      case 'candle':
        unsub = this.provider.streamCandles(msg.symbol, msg.key ?? '1m', (c, isFinal) =>
          publish({ candle: c, isFinal }),
        );
        break;
      case 'depth':
        unsub = this.provider.streamDepth(msg.symbol, (d) => publish(d));
        break;
      case 'trade':
        unsub = this.provider.streamTrades(msg.symbol, (t) => publish(t));
        break;
      case 'ticker':
        unsub = this.provider.streamBookTicker(msg.symbol, (t) => publish(t));
        break;
    }
    return { unsub, refs: 1 };
  }

  private async fetchAndPublishSnapshot(msg: CtrlMessage, k: string): Promise<void> {
    let snapshot: unknown = undefined;
    try {
      switch (msg.channel) {
        case 'candle':
          snapshot = await this.provider.getCandles(msg.symbol, msg.key ?? '1m', { limit: 500 });
          break;
        case 'depth':
          snapshot = await this.provider.getOrderBook(msg.symbol, 100);
          break;
        case 'trade':
        case 'ticker':
          // No REST snapshot — only live ticks.
          return;
      }
    } catch (err) {
      console.error('[snapshot]', this.provider.id, msg.channel, msg.symbol, err);
      return;
    }
    const stream = this.streams.get(k);
    if (stream) stream.lastSnapshot = snapshot;
    this.publishData({
      provider: this.provider.id,
      symbol: msg.symbol.toUpperCase(),
      channel: msg.channel,
      key: msg.key,
      kind: 'snapshot',
      ts: Date.now(),
      data: snapshot,
    });
  }

  private publishData(env: DataEnvelope): void {
    const topic = dataTopic(env.provider, env.symbol, env.channel, env.key);
    this.pub.publish(topic, JSON.stringify(env)).catch(() => {});
  }

  private async handleDiscover(raw: string): Promise<void> {
    let req: DiscoverRequest;
    try { req = JSON.parse(raw); } catch { return; }
    const reply = async (): Promise<DiscoverReply> => {
      try {
        if (req.op === 'search') return { reqId: req.reqId, ok: true, data: await this.provider.searchSymbols(req.query ?? '', req.limit) };
        if (req.op === 'list')   return { reqId: req.reqId, ok: true, data: await this.provider.listSymbols(req.filter as { segment?: string } | undefined) };
        if (req.op === 'meta')   return { reqId: req.reqId, ok: true, data: await this.provider.getInstrumentMeta(req.symbol ?? '') };
        return { reqId: req.reqId, ok: false, error: `unknown op: ${req.op}` };
      } catch (err) {
        return { reqId: req.reqId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const r = await reply();
    await this.pub.publish(discoverRepTopic(this.provider.id, req.reqId), JSON.stringify(r));
  }
}
