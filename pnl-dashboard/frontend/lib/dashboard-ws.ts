'use client';

import { useEffect } from 'react';
import { mutate } from 'swr';

/**
 * Bot dashboard WS → SWR cache push.
 *
 * For positions/wallet we WRITE the WS payload directly into the SWR cache
 * (revalidate: false) so the UI re-renders without round-tripping FastAPI.
 * This matters because Postgres positions.unrealized_pnl is only refreshed
 * on heartbeat (60s), but the bot WS publishes fresh unrealized PnL every
 * 2s in paper_position_update — that is the source of truth at runtime.
 *
 * For trades we just invalidate (no payload arrives in time on each close).
 */
const DEFAULT_URL = process.env.NEXT_PUBLIC_DASHBOARD_WS_URL || 'ws://localhost:4001';

// Shape from PaperExecutionAdapter.getOpenPositions()
interface DashboardPaperPosition {
  orderId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  leverage: number;
  marginUsdt: number;
  liqPrice: number;
  openedAt: number;
  unrealizedUsdt: number;
  stopLoss?: number;
  takeProfit?: number;
}

// Shape FastAPI /positions returns (snake_case)
interface ApiPosition {
  symbol: string;
  order_id: string;
  side: string;
  qty: number;
  entry_price: number;
  leverage: number;
  margin_usdt: number;
  unrealized_pnl: number;
  liq_price: number | null;
  opened_at: number;
  updated_at: number;
  tier: string | null;
}

interface ApiWallet {
  balance_usdt: number;
  equity_usdt: number;
  used_margin_usdt: number;
  unrealized_pnl_usdt: number;
  realized_pnl_usdt: number;
  drawdown_pct: number;
  inr_per_usdt: number;
  open_positions: number;
  ts: number;
}

const toApiPosition = (p: DashboardPaperPosition): ApiPosition => ({
  symbol: p.symbol,
  order_id: p.orderId,
  side: p.side,
  qty: p.quantity,
  entry_price: p.entryPrice,
  leverage: p.leverage,
  margin_usdt: p.marginUsdt,
  unrealized_pnl: p.unrealizedUsdt,
  liq_price: p.liqPrice,
  opened_at: p.openedAt,
  updated_at: Date.now(),
  tier: null,
});

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
        // eslint-disable-next-line no-console
        console.log(`[dashboard-ws] connected: ${url}`);
        try { ws?.send(JSON.stringify({ type: 'snapshot_request' })); } catch {}
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
          case 'position_update': {
            // Direct cache write — bot's view is fresher than the DB.
            const positions = Array.isArray(msg.positions) ? msg.positions : [];
            void mutate('/positions', positions.map(toApiPosition), { revalidate: false });
            break;
          }

          case 'paper_wallet': {
            const wallet: ApiWallet = {
              balance_usdt: msg.balanceUsdt ?? 0,
              equity_usdt: msg.equityUsdt ?? 0,
              used_margin_usdt: msg.usedMarginUsdt ?? 0,
              unrealized_pnl_usdt: msg.unrealizedPnlUsdt ?? 0,
              realized_pnl_usdt: msg.realizedPnlUsdt ?? 0,
              drawdown_pct: 0,
              inr_per_usdt: 0,
              open_positions: 0,
              ts: Date.now(),
            };
            void mutate('/wallet', wallet, { revalidate: false });
            break;
          }

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
            // Will arrive via the next paper_position_update anyway.
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
