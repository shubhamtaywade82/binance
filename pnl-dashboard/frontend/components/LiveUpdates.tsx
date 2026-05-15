'use client';
import { useDashboardLiveUpdates } from '../lib/dashboard-ws';
import { usePnLWebSocket } from '../hooks/usePnLWebSocket';

/**
 * Mount-only side-effect component. Subscribes the SWR cache to two
 * push pipelines so trades/positions/wallet/equity refresh instantly
 * instead of polling.
 *
 *   1. Bot dashboard WS (ws://localhost:4001) — fastest, ~50ms after the
 *      paper adapter fires. Drives the chart overlay too.
 *   2. FastAPI /ws backed by Postgres LISTEN/NOTIFY — authoritative for
 *      anything that round-trips through the DB (trades / positions /
 *      equity_snapshots). Survives if the bot is restarted.
 */
export default function LiveUpdates(): null {
  useDashboardLiveUpdates();
  usePnLWebSocket();
  return null;
}
