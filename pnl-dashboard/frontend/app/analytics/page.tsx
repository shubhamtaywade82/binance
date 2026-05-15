'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';
import { downsampleSeries, formatAxisTimestamp, numericSeriesDomain } from '@/lib/chart-utils';
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
    <div className="flex justify-between items-baseline gap-3 py-2 border-b border-white/5">
      <span className="text-gray-400 shrink-0">{label}</span>
      <div className="text-right min-w-0">
        <span className="font-mono tabular-nums break-all">{value}</span>
        {sub && <span className="text-xs text-gray-500 ml-2">{sub}</span>}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: stats } = useSWR<TradeStats>('/trades/stats', swrFetcher, { refreshInterval: 10000 });
  const { data: equity } = useSWR<EquityPoint[]>('/equity/curve?limit=2000', swrFetcher, { refreshInterval: 30000 });

  const drawdownFull = useMemo(
    () =>
      (equity ?? []).map((e) => ({
        ts: e.ts,
        drawdown: -Math.abs(e.drawdown) * 100,
      })),
    [equity],
  );

  const drawdownChart = useMemo(() => downsampleSeries(drawdownFull, 80), [drawdownFull]);

  const ddYDomain = useMemo(() => {
    const vals = drawdownFull.map((d) => d.drawdown);
    if (vals.length === 0) return [-1, 0] as [number, number];
    return numericSeriesDomain(vals, 0.12);
  }, [drawdownFull]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Analytics</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-bg-card rounded-lg border border-white/5 p-4 sm:p-5">
          <h2 className="text-sm text-gray-400 mb-3">Performance summary</h2>
          <MetricRow label="Total PnL" value={`${(stats?.total_pnl ?? 0).toFixed(2)} USDT`} />
          <MetricRow
            label="Win rate"
            value={`${((stats?.win_rate ?? 0) * 100).toFixed(1)}%`}
            sub={`${stats?.winning_trades ?? 0}W / ${stats?.losing_trades ?? 0}L`}
          />
          <MetricRow label="Avg win" value={`${(stats?.avg_win ?? 0).toFixed(4)} USDT`} />
          <MetricRow label="Avg loss" value={`${(stats?.avg_loss ?? 0).toFixed(4)} USDT`} />
          <MetricRow label="Profit factor" value={(stats?.profit_factor ?? 0).toFixed(2)} />
          <MetricRow label="Total fees" value={`${(stats?.total_fees ?? 0).toFixed(4)} USDT`} />
          <MetricRow label="Total funding" value={`${(stats?.total_funding ?? 0).toFixed(4)} USDT`} />
        </div>

        <div className="bg-bg-card rounded-lg border border-white/5 p-4 sm:p-5">
          <h2 className="text-sm text-gray-400 mb-3">Win / loss distribution</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart
              data={[
                { name: 'Wins', count: stats?.winning_trades ?? 0, fill: '#00e676' },
                { name: 'Losses', count: stats?.losing_trades ?? 0, fill: '#ff1744' },
              ]}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="name" stroke="#64748b" fontSize={12} />
              <YAxis stroke="#64748b" fontSize={10} allowDecimals={false} />
              <Tooltip
                contentStyle={{ background: '#161b22', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
              />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-bg-card rounded-lg border border-white/5 p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h2 className="text-sm font-medium text-gray-300">Drawdown</h2>
          <span className="text-xs text-gray-500 font-mono hidden sm:inline">
            {drawdownChart.length} pts · sampled
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-4">Underwater % from peak equity (sampled for axis clarity).</p>
        <div className="w-full" style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={drawdownChart} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                tickFormatter={(t: number) => formatAxisTimestamp(t)}
                stroke="#64748b"
                fontSize={11}
                minTickGap={48}
                interval="preserveStartEnd"
                angle={-22}
                dy={6}
                textAnchor="end"
                height={58}
              />
              <YAxis
                stroke="#64748b"
                fontSize={11}
                domain={ddYDomain}
                tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  background: '#161b22',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(t: number) => new Date(t).toLocaleString()}
                formatter={(v: number) => [`${v.toFixed(2)}%`, 'Drawdown']}
              />
              <Line type="monotone" dataKey="drawdown" stroke="#ff1744" dot={false} strokeWidth={1.5} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
