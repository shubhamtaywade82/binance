'use client';

import { useEffect } from 'react';
import { mutate } from 'swr';

/**
 * Connects to the trading bot's dashboard WebSocket and triggers SWR cache
 * revalidation when relevant events arrive. This converts the dashboard from
 * polling (2-30s intervals) to push-driven updates.
 *
 * Event → invalidated keys:
 *   paper_trade            → /trades, /trades/stats, /wallet, /equity/curve
 *   paper_position_update  → /positions, /wallet
 *   position_opened        → /positions, /trades, /wallet
 *   position_closed        → /trades, /trades/stats, /positions, /equity/curve, /wallet
 *   trail_update           → /positions   (current trail level for entries)
 *   paper_wallet           → /wallet
 *
 * The bot binds to 127.0.0.1:4001. Browsers on the host can reach it via
 * ws://localhost:4001 (the dashboard already listens for cross-origin clients).
 */
const DEFAULT_URL = process.env.NEXT_PUBLIC_DASHBOARD_WS_URL || 'ws://localhost:4001';

export function useDashboardLiveUpdates(url: string = DEFAULT_URL): void {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        // Optional: request a snapshot on connect.
        ws?.send(JSON.stringify({ type: 'snapshot_request' }));
      };
      ws.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        switch (msg?.type) {
          case 'paper_trade':
            void mutate('/trades?limit=50');
            void mutate('/trades?limit=200');
            void mutate('/trades/stats');
            void mutate('/wallet');
            void mutate('/equity/curve?limit=1000');
            void mutate('/equity/curve?limit=2000');
            break;
          case 'paper_position_update':
          case 'position_update':
            void mutate('/positions');
            void mutate('/wallet');
            break;
          case 'position_opened':
            void mutate('/positions');
            void mutate('/trades?limit=50');
            void mutate('/wallet');
            break;
          case 'position_closed':
            void mutate('/trades?limit=50');
            void mutate('/trades?limit=200');
            void mutate('/trades/stats');
            void mutate('/positions');
            void mutate('/equity/curve?limit=1000');
            void mutate('/equity/curve?limit=2000');
            void mutate('/wallet');
            break;
          case 'trail_update':
            void mutate('/positions');
            break;
          case 'paper_wallet':
            void mutate('/wallet');
            break;
        }
      };
      ws.onclose = () => { ws = null; if (!closed) scheduleReconnect(); };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [url]);
}
