import { RedisAdapter } from '@chart-studio/adapter-core';
import { DhanProvider } from './provider';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const CLIENT_ID = process.env.DHAN_CLIENT_ID ?? '';
const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN ?? '';

const main = async (): Promise<void> => {
  if (!CLIENT_ID || !ACCESS_TOKEN) {
    console.error('[adapter-dhanhq] missing DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN');
    process.exit(1);
  }
  const provider = new DhanProvider({
    id: process.env.DHAN_ADAPTER_ID,
    displayName: process.env.DHAN_ADAPTER_NAME,
    creds: { clientId: CLIENT_ID, accessToken: ACCESS_TOKEN },
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
