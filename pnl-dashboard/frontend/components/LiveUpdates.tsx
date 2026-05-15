'use client';
import { useDashboardLiveUpdates } from '../lib/dashboard-ws';

/**
 * Mount-only side-effect component. Subscribes the SWR cache to the bot's
 * dashboard WebSocket so trades/positions/wallet/equity refresh instantly
 * instead of polling every few seconds.
 */
export default function LiveUpdates(): null {
  useDashboardLiveUpdates();
  return null;
}
