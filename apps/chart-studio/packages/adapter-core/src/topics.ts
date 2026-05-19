import type { Channel } from './types';

/**
 * Redis topic conventions for gateway ↔ adapter traffic.
 *
 * - chart.data.<provider>.<symbol>.<channel>[.<key>]    adapter → gateway (live data + snapshots)
 * - chart.ctrl.<provider>                               gateway → adapter (subscribe/unsubscribe)
 * - chart.discover.<provider>.req                       gateway → adapter (search, list, meta)
 * - chart.discover.<provider>.rep.<reqId>               adapter → gateway (reply)
 * - chart.presence.<provider>                           adapter → gateway (heartbeat, on connect/disconnect)
 */

export const dataTopic = (provider: string, symbol: string, channel: Channel, key?: string): string => {
  const k = key ? `.${key}` : '';
  return `chart.data.${provider}.${symbol.toUpperCase()}.${channel}${k}`;
};

export const dataTopicPattern = (provider: string): string => `chart.data.${provider}.*`;

export const ctrlTopic = (provider: string): string => `chart.ctrl.${provider}`;

export const discoverReqTopic = (provider: string): string => `chart.discover.${provider}.req`;

export const discoverRepTopic = (provider: string, reqId: string): string =>
  `chart.discover.${provider}.rep.${reqId}`;

export const presenceTopic = (provider: string): string => `chart.presence.${provider}`;

export const presencePattern = (): string => `chart.presence.*`;

export interface CtrlMessage {
  op: 'sub' | 'unsub';
  channel: Channel;
  symbol: string;
  /** Interval for candles, omitted for depth/trade/ticker. */
  key?: string;
  reqId: string;
}

export interface DiscoverRequest {
  reqId: string;
  op: 'search' | 'list' | 'meta';
  query?: string;
  symbol?: string;
  filter?: Record<string, unknown>;
  limit?: number;
}

export interface DiscoverReply<T = unknown> {
  reqId: string;
  ok: boolean;
  error?: string;
  data?: T;
}

export interface PresenceMessage {
  provider: string;
  displayName: string;
  /** unix ms */
  ts: number;
  /** "online" sent periodically; "offline" sent on graceful shutdown. */
  state: 'online' | 'offline';
}
