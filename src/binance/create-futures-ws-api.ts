import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config';
import {
  BinanceFuturesWsApiClient,
  createFuturesWsApiClientFromPem,
  futuresWsApiUrlFromConfig,
} from './futures-ws-api';

/**
 * Builds a `ws-fapi` trading client when enabled and PEM path + API key are set.
 * Returns `null` when disabled or incomplete configuration (safe no-op for hybrid bot).
 */
export function tryCreateBinanceFapiWsClient(cfg: AppConfig): BinanceFuturesWsApiClient | null {
  if (!cfg.BINANCE_FAPI_WS_ENABLED) return null;
  const pemPath = cfg.BINANCE_FAPI_ED25519_PRIVATE_KEY_PATH.trim();
  const apiKey = cfg.BINANCE_FAPI_API_KEY.trim();
  if (!pemPath || !apiKey) return null;

  const pem = readFileSync(pemPath, 'utf8');
  const url = futuresWsApiUrlFromConfig({
    explicitUrl: cfg.BINANCE_FAPI_WS_URL?.trim(),
    useTestnet: cfg.BINANCE_PRODUCT === 'usdm' && cfg.BINANCE_FUTURES_TESTNET,
    hideRateLimits: cfg.BINANCE_FAPI_WS_HIDE_RATELIMITS,
  });

  return createFuturesWsApiClientFromPem({
    url,
    apiKey,
    ed25519PrivateKeyPem: pem,
    requestTimeoutMs: cfg.BINANCE_FAPI_WS_REQUEST_TIMEOUT_MS,
  });
}
