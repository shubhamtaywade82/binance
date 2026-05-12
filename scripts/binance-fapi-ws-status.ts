/**
 * Binance USD-M WebSocket trading API — session.logon + session.status (read-only check).
 *
 * Requires Ed25519 API key on Binance account and PEM private key file.
 *
 * Env:
 *   BINANCE_FAPI_WS_ENABLED=true
 *   BINANCE_FAPI_API_KEY=...
 *   BINANCE_FAPI_ED25519_PRIVATE_KEY_PATH=/path/to/ed25519.pem
 *   BINANCE_FUTURES_TESTNET=true   # optional — uses testnet ws-fapi host
 *
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-api-general-info
 */
import { loadConfig } from '../src/config';
import { tryCreateBinanceFapiWsClient } from '../src/binance/create-futures-ws-api';

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const client = tryCreateBinanceFapiWsClient(cfg);
  if (!client) {
    process.stderr.write(
      'Missing Binance ws-fapi setup. Set BINANCE_FAPI_WS_ENABLED=true, BINANCE_FAPI_API_KEY, ' +
        'BINANCE_FAPI_ED25519_PRIVATE_KEY_PATH (Ed25519 PEM).\n',
    );
    process.exit(1);
  }

  await client.connect();
  try {
    await client.logon();
    const status = await client.sessionStatus();
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  process.exit(1);
});
