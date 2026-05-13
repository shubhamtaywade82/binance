import type Redis from 'ioredis';

export const CHANNELS = {
  TICKS:     'ticks',
  SIGNALS:   'signals',
  POSITIONS: 'positions',
  ORDERS:    'orders',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * Publish a JSON payload to a Redis pub/sub channel.
 * Silent no-op when redis is null (REDIS_URL not configured).
 * Publish failures are non-fatal and do not propagate.
 */
export const publish = (redis: Redis | null, channel: Channel, data: unknown): void => {
  if (!redis) return;
  // Fire-and-forget; the bot must not stall on Redis latency.
  redis.publish(channel, JSON.stringify(data)).catch(() => undefined);
};
