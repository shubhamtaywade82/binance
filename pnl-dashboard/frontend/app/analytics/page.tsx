'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';
import { downsampleSeries, formatAxisTimestamp, numericSeriesDomain } from '@/lib/chart-utils';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, BarChart, Bar, AreaChart, Area } from 'recharts';

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

interface WalletState {
  inr_per_usdt: number;
  balance_inr: number;
  equity_inr: number;
}

function MetricRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex justify-between items-baseline gap-3 py-2.5 border-b border-[#131b2d]">
      <span className="text-gray-400 font-medium text-xs tracking-wide">{label}</span>
      <div className="text-right min-w-0">
        <span className="font-mono font-bold text-white text-xs tabular-nums break-all">{value}</span>
        {sub && <span className="text-[10px] text-gray-500 font-bold ml-2 uppercase tracking-wider">{sub}</span>}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const { data: stats } = useSWR<TradeStats>('/trades/stats', swrFetcher, { refreshInterval: 10000 });
  const { data: equity } = useSWR<EquityPoint[]>('/equity/curve?limit=1500', swrFetcher, { refreshInterval: 30000 });
  const { data: wallet } = useSWR<WalletState>('/wallet', swrFetcher, { refreshInterval: 10000 });

  const fxRate = wallet?.inr_per_usdt ?? 85.5;

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

  const chartEquity = useMemo(() => downsampleSeries(equity ?? [], 100), [equity]);
  const equityYDomain = useMemo(() => {
    const vals = (equity ?? []).map((e) => e.equity);
    if (vals.length === 0) return [9500, 10500] as [number, number];
    return numericSeriesDomain(vals, 0.02);
  }, [equity]);

  return (
    <div className="space-y-6 select-none animate-in fade-in duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white tracking-wider uppercase">PERFORMANCE ANALYSIS</h1>
          <p className="text-xs text-gray-500">Detailed stats and equity analytics metrics</p>
        </div>
      </div>

      {/* Main Grid: Equity Chart & Statistics */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Equity Performance Chart (2/3 width) */}
        <div className="lg:col-span-2 bg-[#060913] border border-[#131b2d] rounded-lg p-5">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="text-xs font-bold text-white tracking-widest uppercase">Portfolio Equity</h2>
              <p className="text-[10px] text-gray-500 mt-0.5">Real-time USDT/INR asset progression</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[9px] font-bold text-emerald-400 uppercase tracking-widest">Active Curve</span>
            </div>
          </div>
          <div className="w-full h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartEquity} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.1}/>
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="#131b2d" />
                <XAxis 
                  dataKey="ts" 
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(t) => formatAxisTimestamp(t)}
                  fontSize={9}
                  stroke="#475569"
                  tick={{ fill: '#64748b' }}
                />
                <YAxis 
                  domain={equityYDomain}
                  fontSize={9}
                  stroke="#475569"
                  tick={{ fill: '#64748b' }}
                  tickFormatter={(v) => `$${v}`}
                />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#0b101d', border: '1px solid #131b2d', borderRadius: '4px' }}
                  labelStyle={{ color: '#94a3b8', fontSize: '9px', fontWeight: 'bold' }}
                  itemStyle={{ fontSize: '11px', color: '#fff' }}
                  formatter={(v: number) => [`$${v.toFixed(2)} / ₹${(v * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, 'Equity']}
                  labelFormatter={(t) => new Date(t).toLocaleString()}
                />
                <Area 
                  type="monotone" 
                  dataKey="equity" 
                  stroke="#10b981" 
                  strokeWidth={1.5}
                  fillOpacity={1} 
                  fill="url(#colorEquity)" 
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Performance summary (1/3 width) */}
        <div className="bg-[#060913] border border-[#131b2d] rounded-lg p-5">
          <h2 className="text-xs font-bold text-white tracking-widest uppercase mb-4">PERFORMANCE SUMMARY</h2>
          <div className="space-y-1">
            <MetricRow 
              label="Total Net Profit" 
              value={`${(stats?.total_pnl ?? 0).toFixed(2)} USDT`} 
              sub={`₹${((stats?.total_pnl ?? 0) * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}
            />
            <MetricRow
              label="Win Rate"
              value={`${((stats?.win_rate ?? 0) * 100).toFixed(1)}%`}
              sub={`${stats?.winning_trades ?? 0}W / ${stats?.losing_trades ?? 0}L`}
            />
            <MetricRow 
              label="Average Win" 
              value={`${(stats?.avg_win ?? 0).toFixed(2)} USDT`} 
              sub={`₹${((stats?.avg_win ?? 0) * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}
            />
            <MetricRow 
              label="Average Loss" 
              value={`${(stats?.avg_loss ?? 0).toFixed(2)} USDT`} 
              sub={`₹${((stats?.avg_loss ?? 0) * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}
            />
            <MetricRow label="Profit Factor" value={(stats?.profit_factor ?? 0).toFixed(2)} />
            <MetricRow 
              label="Total Fees Paid" 
              value={`${(stats?.total_fees ?? 0).toFixed(2)} USDT`} 
              sub={`₹${((stats?.total_fees ?? 0) * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}
            />
            <MetricRow 
              label="Funding Adjustments" 
              value={`${(stats?.total_funding ?? 0).toFixed(2)} USDT`} 
              sub={`₹${((stats?.total_funding ?? 0) * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}
            />
          </div>
        </div>
      </div>

      {/* Grid: Drawdown & Win Distribution */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Drawdown */}
        <div className="bg-[#060913] border border-[#131b2d] rounded-lg p-5">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="text-xs font-bold text-white tracking-widest uppercase">Drawdown Profile</h2>
              <p className="text-[10px] text-gray-500 mt-0.5">Underwater percentage from equity peak</p>
            </div>
            <span className="text-[9px] text-gray-500 font-mono">
              {drawdownChart.length} PTS
            </span>
          </div>
          <div className="w-full h-[220px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={drawdownChart} margin={{ top: 8, right: 12, left: -20, bottom: 4 }}>
                <CartesianGrid strokeDasharray="2 2" stroke="#131b2d" />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(t: number) => formatAxisTimestamp(t)}
                  stroke="#475569"
                  fontSize={9}
                  tick={{ fill: '#64748b' }}
                />
                <YAxis
                  stroke="#475569"
                  fontSize={9}
                  domain={ddYDomain}
                  tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  tick={{ fill: '#64748b' }}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#0b101d',
                    border: '1px solid #131b2d',
                    borderRadius: 4,
                  }}
                  labelFormatter={(t: number) => new Date(t).toLocaleString()}
                  formatter={(v: number) => [`${v.toFixed(2)}%`, 'Drawdown']}
                  itemStyle={{ color: '#ef4444', fontSize: '11px' }}
                  labelStyle={{ color: '#94a3b8', fontSize: '9px', fontWeight: 'bold' }}
                />
                <Line type="monotone" dataKey="drawdown" stroke="#ef4444" dot={false} strokeWidth={1.2} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Win / Loss Distribution */}
        <div className="bg-[#060913] border border-[#131b2d] rounded-lg p-5">
          <h2 className="text-xs font-bold text-white tracking-widest uppercase mb-4">Win / Loss Distribution</h2>
          <div className="w-full h-[220px] flex items-center">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={[
                  { name: 'Wins', count: stats?.winning_trades ?? 0, fill: '#10b981' },
                  { name: 'Losses', count: stats?.losing_trades ?? 0, fill: '#ef4444' },
                ]}
                margin={{ left: -20 }}
              >
                <CartesianGrid vertical={false} stroke="#131b2d" />
                <XAxis dataKey="name" stroke="#475569" fontSize={10} tick={{ fill: '#64748b' }} />
                <YAxis stroke="#475569" fontSize={9} allowDecimals={false} tick={{ fill: '#64748b' }} />
                <Tooltip
                  contentStyle={{ background: '#0b101d', border: '1px solid #131b2d', borderRadius: 4 }}
                  itemStyle={{ fontSize: '11px', color: '#fff' }}
                  labelStyle={{ fontSize: '9px', color: '#94a3b8', fontWeight: 'bold' }}
                />
                <Bar dataKey="count" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
