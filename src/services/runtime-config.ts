import type Redis from 'ioredis';

export interface RuntimeConfig {
  exchange: 'binance' | 'coindcx';
  env: 'testnet' | 'mainnet';
}

const STATE_KEY     = 'runtime:config';
const CHANGE_CHANNEL = 'runtime:config:changed';

/**
 * Read the active runtime config from Redis.
 * Returns fallback (derived from static env vars) when Redis is absent or the
 * key has not been written yet.
 */
export const getRuntimeConfig = async (
  redis: Redis | null,
  fallback: RuntimeConfig,
): Promise<RuntimeConfig> => {
  if (!redis) return fallback;
  try {
    const raw = await redis.get(STATE_KEY);
    return raw ? (JSON.parse(raw) as RuntimeConfig) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * Persist a new runtime config to Redis and notify all subscribers so the
 * execution router can pick it up without polling.
 */
export const setRuntimeConfig = async (
  redis: Redis | null,
  config: RuntimeConfig,
): Promise<void> => {
  if (!redis) return;
  await redis.set(STATE_KEY, JSON.stringify(config));
  await redis.publish(CHANGE_CHANNEL, JSON.stringify(config));
};

export { CHANGE_CHANNEL };
