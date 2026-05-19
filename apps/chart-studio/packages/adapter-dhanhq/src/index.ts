import { RedisAdapter } from '@chart-studio/adapter-core';
import { DhanProvider } from './provider';
import { AlgoScalperTokenProvider, StaticTokenProvider, type TokenProvider } from './token-provider';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const ALGO_SCALPER_URL = process.env.ALGO_SCALPER_URL ?? '';
const ALGO_SCALPER_API_KEY = process.env.ALGO_SCALPER_API_KEY ?? '';
const CLIENT_ID = process.env.DHAN_CLIENT_ID ?? '';
const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN ?? '';

const buildTokens = (): TokenProvider | null => {
  if (ALGO_SCALPER_URL) {
    console.log(`[adapter-dhanhq] using algo_scalper_api at ${ALGO_SCALPER_URL}`);
    return new AlgoScalperTokenProvider(ALGO_SCALPER_URL, ALGO_SCALPER_API_KEY ? { apiKey: ALGO_SCALPER_API_KEY } : {});
  }
  if (CLIENT_ID && ACCESS_TOKEN) {
    console.log('[adapter-dhanhq] using static DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN');
    return new StaticTokenProvider({ clientId: CLIENT_ID, accessToken: ACCESS_TOKEN });
  }
  return null;
};

const main = async (): Promise<void> => {
  const tokens = buildTokens();
  if (!tokens) {
    console.error('[adapter-dhanhq] no credentials configured: set ALGO_SCALPER_URL or DHAN_CLIENT_ID + DHAN_ACCESS_TOKEN');
    process.exit(1);
  }
  const provider = new DhanProvider({
    id: process.env.DHAN_ADAPTER_ID,
    displayName: process.env.DHAN_ADAPTER_NAME,
    tokens,
    scripMasterUrl: process.env.DHAN_SCRIP_MASTER_URL,
    feedMode: (process.env.DHAN_FEED_MODE as 'ticker' | 'quote' | 'full' | undefined) ?? 'full',
  });
  const adapter = new RedisAdapter(provider, { redisUrl: REDIS_URL });
  await adapter.start();
  console.log(`[adapter-dhanhq] online: ${provider.id} (${provider.displayName})`);
};

main().catch((err) => {
  console.error('[adapter-dhanhq] fatal', err);
  process.exit(1);
});
