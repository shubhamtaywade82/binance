'use client';

import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';

interface Trade {
  id: number;
  order_id: string;
  timestamp_ms: number;
  symbol: string;
  side: string;
  qty: number;
  entry_price: number;
  exit_price: number;
  gross_pnl: number;
  fees: number;
  funding: number;
  net_pnl: number;
  close_reason: string;
}

export default function TradesPage() {
  const { data: trades } = useSWR<Trade[]>('/trades?limit=200', swrFetcher, { refreshInterval: 5000 });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Trade History</h1>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-gray-500">
              {['Time', 'Symbol', 'Side', 'Qty', 'Entry', 'Exit', 'Gross', 'Fees', 'Funding', 'Net PnL', 'Reason'].map(h => (
                <th key={h} className="px-3 py-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(trades ?? []).map(t => (
              <tr key={t.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                <td className="px-3 py-2 font-mono text-xs">{new Date(t.timestamp_ms).toLocaleString()}</td>
                <td className="px-3 py-2">{t.symbol}</td>
                <td className={`px-3 py-2 font-medium ${t.side === 'LONG' ? 'text-bull' : 'text-bear'}`}>{t.side}</td>
                <td className="px-3 py-2 font-mono">{t.qty.toFixed(4)}</td>
                <td className="px-3 py-2 font-mono">{t.entry_price.toFixed(2)}</td>
                <td className="px-3 py-2 font-mono">{t.exit_price.toFixed(2)}</td>
                <td className={`px-3 py-2 font-mono ${t.gross_pnl >= 0 ? 'text-bull' : 'text-bear'}`}>{t.gross_pnl.toFixed(4)}</td>
                <td className="px-3 py-2 font-mono text-gray-500">{t.fees.toFixed(4)}</td>
                <td className="px-3 py-2 font-mono text-gray-500">{t.funding.toFixed(4)}</td>
                <td className={`px-3 py-2 font-mono font-medium ${t.net_pnl >= 0 ? 'text-bull' : 'text-bear'}`}>{t.net_pnl.toFixed(4)}</td>
                <td className="px-3 py-2 text-gray-400">{t.close_reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!trades || trades.length === 0) && (
          <div className="text-center text-gray-500 py-12">No trades yet</div>
        )}
      </div>
    </div>
  );
}
