import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  ctrlTopic,
  dataTopicPattern,
  discoverReqTopic,
  discoverRepTopic,
  presencePattern,
  presenceTopic,
  type CtrlMessage,
  type DiscoverReply,
  type DiscoverRequest,
  type PresenceMessage,
} from '@chart-studio/adapter-core';
import type { Channel, DataEnvelope } from '@chart-studio/adapter-core';

type DataListener = (env: DataEnvelope) => void;

interface Subscription {
  provider: string;
  symbol: string;
  channel: Channel;
  key?: string;
  listener: DataListener;
}

interface ProviderPresence {
  provider: string;
  displayName: string;
  lastSeen: number;
  online: boolean;
}

/**
 * Glue between Redis pub/sub topics and gateway consumers:
 *  - keep one upstream pSubscribe per channel pattern (data, presence)
 *  - issue request/reply RPCs for discovery
 *  - publish ctrl messages to provider adapters
 */
export class RedisBridge {
  private readonly sub: Redis;
  private readonly pub: Redis;
  private readonly listeners = new Map<string, Set<DataListener>>(); // key = data topic
  private readonly presence = new Map<string, ProviderPresence>();
  private readonly pendingDiscover = new Map<string, (reply: DiscoverReply) => void>();
  private readonly presenceListeners = new Set<(p: ProviderPresence[]) => void>();

  constructor(redisUrl: string) {
    this.sub = new Redis(redisUrl);
    this.pub = new Redis(redisUrl);
  }

  async start(): Promise<void> {
    this.sub.on('pmessage', (_pattern, channel, message) => {
      if (channel.startsWith('chart.data.')) this.routeDataMessage(channel, message);
      else if (channel.startsWith('chart.presence.')) this.routePresenceMessage(message);
      else if (channel.startsWith('chart.discover.') && channel.includes('.rep.')) this.routeDiscoverReply(message);
    });
    await this.sub.psubscribe('chart.data.*', presencePattern());
  }

  async stop(): Promise<void> {
    await this.sub.quit();
    await this.pub.quit();
  }

  // ── Pub: control + discovery ─────────────────────────────────────────

  publishCtrl(provider: string, msg: CtrlMessage): void {
    this.pub.publish(ctrlTopic(provider), JSON.stringify(msg)).catch(() => {});
  }

  async discover<T = unknown>(provider: string, op: 'search' | 'list' | 'meta', payload: Partial<DiscoverRequest> = {}, timeoutMs = 5000): Promise<T | null> {
    const reqId = randomUUID();
    const req: DiscoverRequest = { reqId, op, ...payload };
    const replyTopic = discoverRepTopic(provider, reqId);

    return new Promise<T | null>((resolve) => {
      let resolved = false;
      const finish = (val: T | null): void => {
        if (resolved) return;
        resolved = true;
        this.pendingDiscover.delete(reqId);
        this.sub.unsubscribe(replyTopic).catch(() => {});
        resolve(val);
      };

      this.pendingDiscover.set(reqId, (reply) => {
        if (!reply.ok) return finish(null);
        finish(reply.data as T);
      });

      this.sub.subscribe(replyTopic).then(() => {
        this.pub.publish(discoverReqTopic(provider), JSON.stringify(req)).catch(() => finish(null));
      }).catch(() => finish(null));

      setTimeout(() => finish(null), timeoutMs);
    });
  }

  // ── Sub: data + presence ─────────────────────────────────────────────

  /** Returns an unsub function. Caller is responsible for publishing the ctrl `sub` message. */
  onData(sub: Subscription): () => void {
    const topic = `chart.data.${sub.provider}.${sub.symbol.toUpperCase()}.${sub.channel}${sub.key ? `.${sub.key}` : ''}`;
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(sub.listener);
    return () => {
      const s = this.listeners.get(topic);
      if (!s) return;
      s.delete(sub.listener);
      if (s.size === 0) this.listeners.delete(topic);
    };
  }

  onPresenceChange(listener: (providers: ProviderPresence[]) => void): () => void {
    this.presenceListeners.add(listener);
    listener(this.snapshotPresence());
    return () => { this.presenceListeners.delete(listener); };
  }

  snapshotPresence(): ProviderPresence[] {
    return [...this.presence.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  // ── Internal routing ─────────────────────────────────────────────────

  private routeDataMessage(topic: string, raw: string): void {
    const set = this.listeners.get(topic);
    if (!set || set.size === 0) return;
    let env: DataEnvelope;
    try { env = JSON.parse(raw); } catch { return; }
    for (const fn of set) fn(env);
  }

  private routePresenceMessage(raw: string): void {
    let msg: PresenceMessage;
    try { msg = JSON.parse(raw); } catch { return; }
    const prev = this.presence.get(msg.provider);
    this.presence.set(msg.provider, {
      provider: msg.provider,
      displayName: msg.displayName,
      lastSeen: msg.ts,
      online: msg.state === 'online',
    });
    const wasOnline = prev?.online ?? false;
    const nowOnline = msg.state === 'online';
    if (wasOnline !== nowOnline) {
      const snap = this.snapshotPresence();
      for (const fn of this.presenceListeners) fn(snap);
    }
  }

  private routeDiscoverReply(raw: string): void {
    let reply: DiscoverReply;
    try { reply = JSON.parse(raw); } catch { return; }
    const cb = this.pendingDiscover.get(reply.reqId);
    if (cb) cb(reply);
  }
}
