import { RedisAdapter } from '@chart-studio/adapter-core';
import { BinanceProvider } from './provider';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const PRODUCT = (process.env.BINANCE_PRODUCT ?? 'usdm') === 'spot' ? 'spot' : 'usdm';

const main = async (): Promise<void> => {
  const provider = new BinanceProvider({
    product: PRODUCT,
    id: process.env.BINANCE_ADAPTER_ID,
    displayName: process.env.BINANCE_ADAPTER_NAME,
    restBase: process.env.BINANCE_REST_BASE,
    wsBase: process.env.BINANCE_WS_BASE,
  });
  const adapter = new RedisAdapter(provider, { redisUrl: REDIS_URL });
  await adapter.start();
  console.log(`[adapter-binance] online: ${provider.id} (${provider.displayName})`);
};

main().catch((err) => {
  console.error('[adapter-binance] fatal', err);
  process.exit(1);
});
