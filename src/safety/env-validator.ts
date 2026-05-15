import type { AppConfig } from '../config';

interface MinimalLogger {
  warn(msg: string, meta?: object): void;
}

const BANNER = '⚠️  SAFETY';

/**
 * Validates environment configuration at startup and throws on unsafe combinations
 * that lack explicit operator acknowledgment.
 *
 * Call this early in the bootstrap sequence — before any WebSocket or REST connections.
 */
export const validateEnvironment = (cfg: AppConfig, logger: MinimalLogger): void => {
  const isLive = cfg.EXECUTION_MODE === 'live';
  const isMainnet = !cfg.BINANCE_FUTURES_TESTNET;

  if (isLive && isMainnet && !cfg.CONFIRMED_LIVE_TRADING) {
    const msg =
      'EXECUTION_MODE=live on mainnet requires CONFIRMED_LIVE_TRADING=true. ' +
      'Refusing to start — set the flag explicitly to confirm real-money trading.';
    logger.warn(`${BANNER}: ${msg}`);
    throw new Error(msg);
  }

  if (cfg.BINANCE_FUTURES_TESTNET) {
    logger.warn(
      `${BANNER}: BINANCE_FUTURES_TESTNET=true — fills and slippage on testnet are ` +
        'not realistic and paper results will not transfer directly to mainnet.',
    );
  }

  if (isLive && cfg.BINANCE_DEADMAN_COUNTDOWN_MS === 0) {
    logger.warn(
      `${BANNER}: EXECUTION_MODE=live with dead-man switch disabled ` +
        '(BINANCE_DEADMAN_COUNTDOWN_MS=0). Open orders will NOT auto-cancel on disconnect.',
    );
  }

  if (isLive && cfg.DAILY_DRAWDOWN_KILL_PCT === 0) {
    logger.warn(
      `${BANNER}: EXECUTION_MODE=live with no drawdown kill switch ` +
        '(DAILY_DRAWDOWN_KILL_PCT=0). There is no automatic equity protection.',
    );
  }

  if (isLive && cfg.MAX_OPEN_POSITIONS === 0) {
    logger.warn(
      `${BANNER}: EXECUTION_MODE=live with unlimited concurrent positions ` +
        '(MAX_OPEN_POSITIONS=0). Consider setting a cap.',
    );
  }

  if (isLive && cfg.MAX_NOTIONAL_USDT === 0) {
    logger.warn(
      `${BANNER}: EXECUTION_MODE=live with no per-order notional cap ` +
        '(MAX_NOTIONAL_USDT=0). A fat-finger order has no upper bound.',
    );
  }
};
