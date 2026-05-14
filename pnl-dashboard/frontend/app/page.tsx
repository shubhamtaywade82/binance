'use client';

import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';

interface TradeStats {
  total_trades: number;
  total_pnl: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  profit_factor: number;
  total_fees: number;
  total_funding: number;
}

interface EquityPoint {
  ts: number;
  equity: number;
  drawdown: number;
  balance: number;
  open_positions: number;
}

interface WalletState {
  balance: number;
  equity: number;
  used_margin: number;
  unrealized_pnl: number;
  realized_pnl: number;
  open_positions: number;
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-bg-card rounded-lg border border-white/5 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-mono mt-1 ${color || 'text-white'}`}>{value}</div>
    </div>
  );
}

export default function OverviewPage() {
  const { data: stats } = useSWR<TradeStats>('/trades/stats', swrFetcher, { refreshInterval: 5000 });
  const { data: equity } = useSWR<EquityPoint[]>('/equity/curve?limit=500', swrFetcher, { refreshInterval: 10000 });
  const { data: wallet } = useSWR<WalletState>('/wallet', swrFetcher, { refreshInterval: 3000 });

  const pnlColor = (stats?.total_pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear';

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total PnL" value={`${(stats?.total_pnl ?? 0).toFixed(2)} USDT`} color={pnlColor} />
        <StatCard label="Win Rate" value={`${((stats?.win_rate ?? 0) * 100).toFixed(1)}%`} />
        <StatCard label="Total Trades" value={String(stats?.total_trades ?? 0)} />
        <StatCard label="Profit Factor" value={(stats?.profit_factor ?? 0).toFixed(2)} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Balance" value={`${(wallet?.balance ?? 0).toFixed(2)} USDT`} />
        <StatCard label="Equity" value={`${(wallet?.equity ?? 0).toFixed(2)} USDT`} />
        <StatCard
          label="Unrealized PnL"
          value={`${(wallet?.unrealized_pnl ?? 0).toFixed(4)} USDT`}
          color={(wallet?.unrealized_pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear'}
        />
      </div>

      <div className="bg-bg-card rounded-lg border border-white/5 p-4">
        <h2 className="text-sm text-gray-400 mb-4">Equity Curve</h2>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={equity ?? []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis
              dataKey="ts"
              tickFormatter={(t: number) => new Date(t).toLocaleDateString()}
              stroke="#64748b"
              fontSize={10}
            />
            <YAxis stroke="#64748b" fontSize={10} />
            <Tooltip
              contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
              labelFormatter={(t: number) => new Date(t).toLocaleString()}
            />
            <Line type="monotone" dataKey="equity" stroke="#00e676" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
