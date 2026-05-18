import type Redis from 'ioredis';

export const SELFLEARN_OVERRIDES_KEY = 'selflearn:asset_tier_overrides_json';
export const SELFLEARN_CHANGE_CHANNEL = 'selflearn:config:changed';

export const publishTierOverrides = async (redis: Redis | null, overrides: unknown): Promise<void> => {
  if (!redis) return;
  await redis.set(SELFLEARN_OVERRIDES_KEY, JSON.stringify(overrides));
  await redis.publish(SELFLEARN_CHANGE_CHANNEL, JSON.stringify({ ts: Date.now(), overrides }));
};
