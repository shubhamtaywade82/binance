'use client';

import { useEffect, useState, useCallback } from 'react';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'warn' | 'error';
}

const DEFAULT_URL = process.env.NEXT_PUBLIC_DASHBOARD_WS_URL || 'ws://localhost:4001';

/**
 * Mount-only side-effect component. Connects to the bot's dashboard WS and
 * surfaces order_rejected / position_closed / position_opened as transient
 * toasts at top-right. Complements the SWR cache push from useDashboardLiveUpdates.
 *
 * The toasts make trade lifecycle visible without forcing the user to watch
 * the positions table.
 */
export default function Toaster(): JSX.Element | null {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      try {
        ws = new WebSocket(DEFAULT_URL);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onmessage = (ev) => {
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        switch (m?.type) {
          case 'order_rejected':
            push(`Rejected ${m.symbol ?? m.requested?.symbol ?? ''} · ${m.reason ?? 'UNKNOWN'}`, 'warn');
            break;
          case 'position_opened':
            push(`Opened ${m.symbol ?? '?'} ${m.side ?? ''} @ ${Number(m.price ?? 0).toFixed(4)}`, 'info');
            break;
          case 'position_closed': {
            const net = Number(m.netUsdt ?? 0);
            push(`Closed ${m.symbol ?? '?'} · ${m.reason ?? ''} · ${net >= 0 ? '+' : ''}${net.toFixed(2)}`, net >= 0 ? 'success' : 'warn');
            break;
          }
          case 'strategy_signal':
            // Quieter — only push high-confidence signals to avoid spam.
            if ((m.confidence ?? 0) >= 0.75) {
              push(`Signal ${m.symbol ?? ''} ${m.signal} · ${m.regime ?? ''} ${Math.round((m.confidence ?? 0) * 100)}%`, 'info');
            }
            break;
        }
      };
      ws.onclose = () => { ws = null; if (!closed) scheduleReconnect(); };
      ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
    };
    const scheduleReconnect = () => {
      if (closed) return;
      if (reconnect) clearTimeout(reconnect);
      reconnect = setTimeout(connect, 3000);
    };
    connect();
    return () => {
      closed = true;
      if (reconnect) clearTimeout(reconnect);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [push]);

  if (toasts.length === 0) return null;

  const bgFor = (k: Toast['kind']) =>
    k === 'warn' ? 'bg-orange-500/95'
    : k === 'success' ? 'bg-bull/95'
    : k === 'error' ? 'bg-bear/95'
    : 'bg-slate-700/95';

  return (
    <div className="fixed top-20 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-2 rounded-md shadow-2xl text-white text-xs font-mono max-w-xs animate-fadeIn ${bgFor(t.kind)}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
