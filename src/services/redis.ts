import Redis from 'ioredis';

let _redis: Redis | null = null;

/**
 * Returns a shared ioredis client for the given URL, or null when no URL is
 * configured. The same instance is reused across calls (singleton per process).
 * All Redis features are opt-in: when REDIS_URL is absent the bot runs without
 * any Redis calls.
 *
 * M-2: resilient connection options.
 *   • enableOfflineQueue: true — commands issued while disconnected are
 *     queued (capped by ioredis at its internal default) so a transient
 *     blip doesn't surface as immediate write failures everywhere. Bounded
 *     by maxRetriesPerRequest=20 to avoid unbounded growth.
 *   • retryStrategy — exponential backoff from 200ms to 30s with full
 *     jitter, so a fleet of bots reconnecting to the same Redis cluster
 *     doesn't synchronise their reconnect attempts.
 *   • maxRetriesPerRequest: 20 — was 3 (too short for a transient network
 *     hiccup); 20 attempts at backoff cap still fail in <2 min.
 *   • reconnectOnError — reconnect on the standard transient classifications
 *     (READONLY = replica promotion, ETIMEDOUT) instead of bailing.
 */
export const getRedisClient = (url: string | undefined): Redis | null => {
  if (!url) return null;
  if (!_redis) {
    _redis = new Redis(url, {
      enableOfflineQueue: true,
      lazyConnect: false,
      maxRetriesPerRequest: 20,
      retryStrategy: (times: number): number => {
        // 200ms × 2^attempt, capped at 30s, with ±25% jitter so concurrent
        // clients don't thunder-herd a single Redis on reconnect.
        const base = Math.min(30_000, 200 * 2 ** Math.min(times, 8));
        const jitter = base * 0.25 * (Math.random() * 2 - 1);
        return Math.max(50, Math.floor(base + jitter));
      },
      reconnectOnError: (err: Error): boolean => {
        const msg = err.message || '';
        return /READONLY|ETIMEDOUT|ECONNRESET|EPIPE/.test(msg);
      },
    });
    _redis.on('error', (err) => {
      // Non-fatal: log but never crash the bot on Redis issues.
      process.stderr.write(`redis_error ${(err as Error).message}\n`);
    });
    _redis.on('reconnecting', (delayMs: number) => {
      process.stderr.write(`redis_reconnecting ${delayMs}ms\n`);
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
