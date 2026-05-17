import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Redis from 'ioredis';
import { loadConfig } from '../src/config';
import { PgWriter } from '../src/persistence/pg-writer';
import type { ClosedPosition } from '../src/execution/types';

async function main() {
  const cfg = loadConfig();
  const pgUrl = cfg.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5434/bot';
  console.log(`[sync] Connecting to Postgres at ${pgUrl}...`);
  const pgWriter = new PgWriter({ connectionString: pgUrl });
  await pgWriter.connect();

  if (!pgWriter.isConnected) {
    console.error('[sync] Failed to connect to Postgres.');
    process.exit(1);
  }

  // 1. Sync trades from paper/trades.jsonl
  const tradesPath = path.resolve(__dirname, '../paper/trades.jsonl');
  if (fs.existsSync(tradesPath)) {
    console.log(`[sync] Reading trades from ${tradesPath}...`);
    const fileStream = fs.createReadStream(tradesPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let count = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        const closed: ClosedPosition = {
          orderId: t.orderId,
          side: t.side,
          leverage: Number(t.leverage) || 5,
          entryPrice: Number(t.entryPrice) || 0,
          exitPrice: Number(t.exitPrice) || 0,
          quantity: Number(t.quantity) || 0,
          reason: t.reason || 'MANUAL',
          grossUsdt: Number(t.grossUsdt) || 0,
          feesUsdt: Number(t.feesUsdt) || 0,
          fundingUsdt: Number(t.fundingUsdt) || 0,
          netUsdt: Number(t.netUsdt) || 0,
          openedAt: Number(t.openedAt) || 0,
          closedAt: Number(t.closedAt) || Date.now(),
          attribution: t.attribution,
        };
        const symbol = t.symbol || t.pair || 'SOLUSDT';
        await pgWriter.writeTrade(closed, symbol);
        count++;
      } catch (err) {
        console.warn('[sync] Failed to parse trade line:', err);
      }
    }
    console.log(`[sync] Successfully synced ${count} trades to Postgres.`);
  } else {
    console.log('[sync] No paper/trades.jsonl found.');
  }

  // 2. Sync active positions from Redis
  if (cfg.REDIS_URL) {
    console.log(`[sync] Connecting to Redis at ${cfg.REDIS_URL}...`);
    const redis = new Redis(cfg.REDIS_URL);
    const ns = cfg.REDIS_NAMESPACE || 'binance';
    const posKey = `${ns}:paper:positions`;
    try {
      const positionsMap = await redis.hgetall(posKey);
      const keys = Object.keys(positionsMap);
      console.log(`[sync] Found ${keys.length} active positions in Redis (${posKey})...`);
      for (const key of keys) {
        const raw = positionsMap[key];
        try {
          const p = JSON.parse(raw);
          await pgWriter.upsertPosition({
            orderId: p.orderId,
            symbol: p.symbol || 'SOLUSDT',
            side: p.side,
            quantity: Number(p.quantity) || 0,
            entryPrice: Number(p.entryPrice) || 0,
            leverage: Number(p.leverage) || 10,
            marginUsdt: Number(p.marginUsdt) || 0,
            liqPrice: Number(p.liqPrice) || 0,
            openedAt: Number(p.openedAt) || Date.now(),
            unrealizedPnl: Number(p.unrealizedPnl) || 0,
            mode: p.mode || 'paper',
          });
          console.log(`[sync] Upserted position ${p.symbol} (${p.side})`);
        } catch (err) {
          console.warn(`[sync] Failed to parse position ${key}:`, err);
        }
      }
    } catch (err) {
      console.warn('[sync] Failed to read Redis positions:', err);
    } finally {
      await redis.quit();
    }
  } else {
    console.log('[sync] REDIS_URL not set, skipping Redis positions sync.');
  }

  await pgWriter.close();
  console.log('[sync] Sync complete!');
}

main().catch((err) => {
  console.error('[sync] Error:', err);
  process.exit(1);
});
