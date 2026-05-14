'use client';

import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, BarChart, Bar } from 'recharts';

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
}

function MetricRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex justify-between items-baseline py-2 border-b border-white/5">
      <span className="text-gray-400">{label}</span>
      <div className="text-right">
        <span className="font-mono">{value}</span>
        {sub && <span className="text-xs text-gray-500 ml-2">{sub}</span>}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: stats } = useSWR<TradeStats>('/trades/stats', swrFetcher, { refreshInterval: 10000 });
  const { data: equity } = useSWR<EquityPoint[]>('/equity/curve?limit=2000', swrFetcher, { refreshInterval: 30000 });

  const drawdownData = (equity ?? []).map(e => ({
    ts: e.ts,
    drawdown: -Math.abs(e.drawdown) * 100,
  }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Analytics</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-bg-card rounded-lg border border-white/5 p-4">
          <h2 className="text-sm text-gray-400 mb-3">Performance Summary</h2>
          <MetricRow label="Total PnL" value={`${(stats?.total_pnl ?? 0).toFixed(2)} USDT`} />
          <MetricRow label="Win Rate" value={`${((stats?.win_rate ?? 0) * 100).toFixed(1)}%`} sub={`${stats?.winning_trades ?? 0}W / ${stats?.losing_trades ?? 0}L`} />
          <MetricRow label="Avg Win" value={`${(stats?.avg_win ?? 0).toFixed(4)} USDT`} />
          <MetricRow label="Avg Loss" value={`${(stats?.avg_loss ?? 0).toFixed(4)} USDT`} />
          <MetricRow label="Profit Factor" value={(stats?.profit_factor ?? 0).toFixed(2)} />
          <MetricRow label="Total Fees" value={`${(stats?.total_fees ?? 0).toFixed(4)} USDT`} />
          <MetricRow label="Total Funding" value={`${(stats?.total_funding ?? 0).toFixed(4)} USDT`} />
        </div>

        <div className="bg-bg-card rounded-lg border border-white/5 p-4">
          <h2 className="text-sm text-gray-400 mb-3">Win / Loss Distribution</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={[
              { name: 'Wins', count: stats?.winning_trades ?? 0, fill: '#00e676' },
              { name: 'Losses', count: stats?.losing_trades ?? 0, fill: '#ff1744' },
            ]}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#64748b" fontSize={12} />
              <YAxis stroke="#64748b" fontSize={10} />
              <Tooltip contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-bg-card rounded-lg border border-white/5 p-4">
        <h2 className="text-sm text-gray-400 mb-4">Drawdown Chart</h2>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={drawdownData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
            <XAxis
              dataKey="ts"
              tickFormatter={(t: number) => new Date(t).toLocaleDateString()}
              stroke="#64748b"
              fontSize={10}
            />
            <YAxis stroke="#64748b" fontSize={10} unit="%" />
            <Tooltip
              contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
              labelFormatter={(t: number) => new Date(t).toLocaleString()}
              formatter={(v: number) => [`${v.toFixed(2)}%`, 'Drawdown']}
            />
            <Line type="monotone" dataKey="drawdown" stroke="#ff1744" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
