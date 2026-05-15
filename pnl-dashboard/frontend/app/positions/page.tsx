'use client';

import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';

interface Position {
  order_id: string;
  symbol: string;
  side: string;
  qty: number;
  entry_price: number;
  leverage: number;
  margin_usdt: number;
  unrealized_pnl: number;
  liq_price: number;
  opened_at: number;
  tier?: string | null;
}

export default function PositionsPage() {
  const { data: positions } = useSWR<Position[]>('/positions', swrFetcher, { refreshInterval: 2000 });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Open Positions</h1>
      {(!positions || positions.length === 0) ? (
        <div className="bg-bg-card rounded-lg border border-white/5 p-12 text-center text-gray-500">
          No open positions
        </div>
      ) : (
        <div className="grid gap-4">
          {positions.map(p => (
            <div key={p.order_id} className="bg-bg-card rounded-lg border border-white/5 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="font-bold">{p.symbol}</span>
                  <span className={`text-sm font-medium px-2 py-0.5 rounded ${p.side === 'LONG' ? 'bg-bull/20 text-bull' : 'bg-bear/20 text-bear'}`}>
                    {p.side}
                  </span>
                  <span className="text-sm text-gray-500">{p.leverage}x</span>
                  {p.tier ? (
                    <span className="text-xs font-medium px-2 py-0.5 rounded bg-white/5 text-gray-300 uppercase tracking-wide">
                      {p.tier}
                    </span>
                  ) : null}
                </div>
                <div className={`text-lg font-mono font-medium ${p.unrealized_pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {p.unrealized_pnl >= 0 ? '+' : ''}{p.unrealized_pnl.toFixed(4)} USDT
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                <div>
                  <div className="text-gray-500">Entry</div>
                  <div className="font-mono">{p.entry_price.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-gray-500">Qty</div>
                  <div className="font-mono">{p.qty.toFixed(4)}</div>
                </div>
                <div>
                  <div className="text-gray-500">Margin</div>
                  <div className="font-mono">{p.margin_usdt.toFixed(2)} USDT</div>
                </div>
                <div>
                  <div className="text-gray-500">Liq Price</div>
                  <div className="font-mono text-bear">{p.liq_price?.toFixed(2) ?? '-'}</div>
                </div>
                <div>
                  <div className="text-gray-500">Opened</div>
                  <div className="font-mono text-xs">{new Date(p.opened_at).toLocaleString()}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
