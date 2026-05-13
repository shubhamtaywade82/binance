import Redis from 'ioredis';

let _redis: Redis | null = null;

/**
 * Returns a shared ioredis client for the given URL, or null when no URL is configured.
 * The same instance is reused across calls (singleton per process).
 * All Redis features are opt-in: when REDIS_URL is absent the bot runs without any Redis calls.
 */
export const getRedisClient = (url: string | undefined): Redis | null => {
  if (!url) return null;
  if (!_redis) {
    _redis = new Redis(url, {
      enableOfflineQueue: false,
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
    _redis.on('error', (err) => {
      // Non-fatal: log but never crash the bot on Redis issues.
      process.stderr.write(`redis_error ${(err as Error).message}\n`);
    });
  }
  return _redis;
};

/** Close the shared client (call during graceful shutdown). */
export const closeRedisClient = async (): Promise<void> => {
  if (_redis) {
    await _redis.quit().catch(() => undefined);
    _redis = null;
  }
};
