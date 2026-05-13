import type Redis from 'ioredis';

/** Write the current open position for a symbol to Redis state. */
export const setPosition = (redis: Redis | null, symbol: string, data: unknown): void => {
  if (!redis) return;
  redis.set(`state:position:${symbol.toUpperCase()}`, JSON.stringify(data)).catch(() => undefined);
};

/** Remove the position state key when a position is closed. */
export const clearPosition = (redis: Redis | null, symbol: string): void => {
  if (!redis) return;
  redis.del(`state:position:${symbol.toUpperCase()}`).catch(() => undefined);
};

/** Read the last persisted position for a symbol (for startup recovery). */
export const getPosition = async (redis: Redis | null, symbol: string): Promise<unknown> => {
  if (!redis) return null;
  const raw = await redis.get(`state:position:${symbol.toUpperCase()}`);
  return raw ? (JSON.parse(raw) as unknown) : null;
};

/** Write current account balance to Redis state. */
export const setBalance = (redis: Redis | null, balanceUsdt: number): void => {
  if (!redis) return;
  redis.set('state:balance', String(balanceUsdt)).catch(() => undefined);
};

/**
 * Returns true when the operator has set the kill-switch key.
 * Activate:   redis-cli SET state:kill_switch 1
 * Deactivate: redis-cli SET state:kill_switch 0
 */
export const isKillSwitchActive = async (redis: Redis | null): Promise<boolean> => {
  if (!redis) return false;
  return (await redis.get('state:kill_switch').catch(() => null)) === '1';
};
