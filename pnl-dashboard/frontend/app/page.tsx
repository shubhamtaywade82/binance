'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';
import { downsampleSeries, formatAxisTimestamp, numericSeriesDomain } from '@/lib/chart-utils';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, AreaChart, Area } from 'recharts';

// --- Types ---

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
  inr_per_usdt: number;
  balance_inr: number;
  equity_inr: number;
  used_margin_inr: number;
  unrealized_pnl_inr: number;
  realized_pnl_inr: number;
}

interface FxState {
  inr_per_usdt: number;
  ts: number | null;
  source: string;
}

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

interface Trade {
  id: number;
  order_id: string;
  timestamp_ms: number;
  symbol: string;
  side: string;
  leverage: number | null;
  qty: number;
  entry_price: number;
  exit_price: number;
  gross_pnl: number;
  fees: number;
  funding: number;
  net_pnl: number;
  close_reason: string;
}

// --- Helpers ---

const fmtInr = (v: number): string => {
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
};

const fmtUsdt = (v: number, digits = 2): string => {
  const sign = v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toFixed(digits)}`;
};

import { usePnLWebSocket } from '@/hooks/usePnLWebSocket';

// --- Components ---

function LiveIndicator({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10">
      <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-bull animate-pulse shadow-[0_0_8px_rgba(0,230,118,0.8)]' : 'bg-gray-600'}`} />
      <span className="text-[10px] font-bold text-gray-400 uppercase tracking-tighter">
        {connected ? 'Live Stream' : 'Offline'}
      </span>
    </div>
  );
}

function KpiCard({ label, value, subValue, color, icon }: { 
  label: string; 
  value: string; 
  subValue?: string; 
  color?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="glass-card p-4 flex flex-col gap-1 relative overflow-hidden group">
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent pointer-events-none" />
      <div className="flex items-center justify-between relative z-10">
        <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">{label}</span>
        {icon}
      </div>
      <div className={`text-2xl font-mono tabular-nums font-bold relative z-10 ${color || 'text-white'}`}>
        {value}
      </div>
      {subValue && (
        <div className="text-[10px] font-mono text-gray-500 truncate relative z-10">
          {subValue}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-end justify-between mb-4 px-1">
      <div>
        <h2 className="text-lg font-bold text-white tracking-tight leading-none mb-1">{title}</h2>
        {subtitle && <p className="text-xs text-gray-500 font-medium">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export default function UnifiedDashboard() {
  const { isConnected } = usePnLWebSocket();

  // Polling intervals increased significantly or disabled as WebSocket mutates the cache
  const { data: stats } = useSWR<TradeStats>('/trades/stats', swrFetcher, { refreshInterval: 60000 });
  const { data: equitySeries } = useSWR<EquityPoint[]>('/equity/curve?limit=1000', swrFetcher, { refreshInterval: 60000 });
  const { data: wallet } = useSWR<WalletState>('/wallet', swrFetcher, { refreshInterval: 30000 });
  const { data: fx } = useSWR<FxState>('/wallet/fx', swrFetcher, { refreshInterval: 300000 });
  const { data: positions } = useSWR<Position[]>('/positions', swrFetcher, { refreshInterval: 30000 });
  const { data: trades } = useSWR<Trade[]>('/trades?limit=50', swrFetcher, { refreshInterval: 60000 });

  const fxRate = wallet?.inr_per_usdt ?? fx?.inr_per_usdt ?? 85;
  const lastEq = equitySeries && equitySeries.length > 0 ? equitySeries[equitySeries.length - 1] : null;
  const ddPct = lastEq ? lastEq.drawdown : 0;
  
  const chartEquity = useMemo(() => downsampleSeries(equitySeries ?? [], 100), [equitySeries]);
  const equityYDomain = useMemo(() => {
    const vals = (equitySeries ?? []).map((e) => e.equity);
    if (vals.length === 0) return [9500, 10500] as [number, number];
    return numericSeriesDomain(vals, 0.02);
  }, [equitySeries]);

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto animate-in fade-in duration-700">
      
      {/* Header with Live Indicator */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-black text-white tracking-tighter uppercase italic">
            Terminal <span className="text-accent not-italic font-normal opacity-50">v2.1</span>
          </h1>
          <LiveIndicator connected={isConnected} />
        </div>
        <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest hidden sm:block">
          System Clock: <span className="text-gray-300">{new Date().toLocaleTimeString()}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KpiCard 
          label="Portfolio Equity" 
          value={`${fmtUsdt(wallet?.equity ?? 0)}`} 
          subValue={fmtInr(wallet?.equity_inr ?? 0)}
          color="text-white"
        />
        <KpiCard 
          label="Net Realized" 
          value={`${fmtUsdt(wallet?.realized_pnl ?? 0)}`} 
          subValue={fmtInr(wallet?.realized_pnl_inr ?? 0)}
          color={(wallet?.realized_pnl ?? 0) >= 0 ? 'text-bull text-glow-bull' : 'text-bear text-glow-bear'}
        />
        <KpiCard 
          label="Unrealized PnL" 
          value={`${fmtUsdt(wallet?.unrealized_pnl ?? 0)}`} 
          subValue={fmtInr(wallet?.unrealized_pnl_inr ?? 0)}
          color={(wallet?.unrealized_pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear'}
        />
        <KpiCard 
          label="Drawdown" 
          value={`${ddPct.toFixed(2)}%`} 
          color={ddPct >= -2 ? 'text-bull' : ddPct >= -5 ? 'text-amber-400' : 'text-bear'}
        />
        <KpiCard 
          label="Win Rate" 
          value={`${((stats?.win_rate ?? 0) * 100).toFixed(1)}%`} 
          subValue={`${stats?.winning_trades}/${stats?.total_trades} trades`}
        />
        <KpiCard 
          label="Profit Factor" 
          value={(stats?.profit_factor ?? 0).toFixed(2)} 
          subValue={`Ratio: Avg Win/Loss`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        
        {/* Left Column: Chart & Recent Trades (2/3) */}
        <div className="lg:col-span-8 space-y-8">
          
          {/* Equity Chart Section */}
          <div className="glass-panel p-6">
            <SectionHeader 
              title="Equity Performance" 
              subtitle="Real-time USDT portfolio value over time"
              right={
                <div className="flex gap-4">
                   <div className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full bg-bull" />
                    <span className="text-[10px] font-bold text-gray-500 uppercase">Equity</span>
                  </div>
                </div>
              }
            />
            <div className="w-full h-[360px] mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartEquity} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorEquity" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00e676" stopOpacity={0.1}/>
                      <stop offset="95%" stopColor="#00e676" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} />
                  <XAxis 
                    dataKey="ts" 
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(t) => formatAxisTimestamp(t)}
                    fontSize={10}
                    stroke="#475569"
                    tick={{ fill: '#64748b' }}
                  />
                  <YAxis 
                    domain={equityYDomain}
                    fontSize={10}
                    stroke="#475569"
                    tick={{ fill: '#64748b' }}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#0d1117', border: '1px solid #1e293b', borderRadius: '8px' }}
                    labelStyle={{ color: '#94a3b8', fontSize: '10px' }}
                    itemStyle={{ fontSize: '12px', color: '#fff' }}
                    formatter={(v: number) => [`$${fmtUsdt(v)}`, 'Equity']}
                    labelFormatter={(t) => new Date(t).toLocaleString()}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="equity" 
                    stroke="#00e676" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorEquity)" 
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Trade History Section */}
          <div className="glass-panel p-6 overflow-hidden">
            <SectionHeader title="Recent Activity" subtitle="Last 50 execution events" />
            <div className="overflow-x-auto scrollbar-hide">
              <table className="w-full text-[11px] font-mono">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-white/5">
                    <th className="pb-3 pr-4 font-bold uppercase tracking-wider">Time</th>
                    <th className="pb-3 px-4 font-bold uppercase tracking-wider text-center">Symbol</th>
                    <th className="pb-3 px-4 font-bold uppercase tracking-wider text-center">Side</th>
                    <th className="pb-3 px-4 font-bold uppercase tracking-wider text-right">Size</th>
                    <th className="pb-3 px-4 font-bold uppercase tracking-wider text-right">Entry/Exit</th>
                    <th className="pb-3 px-4 font-bold uppercase tracking-wider text-right">Net PnL</th>
                    <th className="pb-3 pl-4 font-bold uppercase tracking-wider text-right">Reason</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.02]">
                  {(trades ?? []).map((t) => (
                    <tr key={t.id} className="hover:bg-white/[0.02] transition-colors group">
                      <td className="py-2.5 pr-4 text-gray-500 whitespace-nowrap">
                        {new Date(t.timestamp_ms).toLocaleTimeString()}
                      </td>
                      <td className="py-2.5 px-4 font-bold text-center text-white">{t.symbol}</td>
                      <td className="py-2.5 px-4 text-center">
                        <span className={`px-2 py-0.5 rounded-sm font-bold text-[9px] ${t.side === 'LONG' ? 'bg-bull/10 text-bull border border-bull/20' : 'bg-bear/10 text-bear border border-bear/20'}`}>
                          {t.side}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-gray-300">
                        {t.qty.toFixed(4)}
                      </td>
                      <td className="py-2.5 px-4 text-right tabular-nums text-gray-400">
                        {t.entry_price.toFixed(2)} → {t.exit_price.toFixed(2)}
                      </td>
                      <td className={`py-2.5 px-4 text-right tabular-nums font-bold ${t.net_pnl >= 0 ? 'text-bull' : 'text-bear'}`}>
                        {t.net_pnl >= 0 ? '+' : ''}{t.net_pnl.toFixed(2)}
                      </td>
                      <td className="py-2.5 pl-4 text-right text-gray-600 italic">
                        {t.close_reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Active Positions & Detailed Stats (1/3) */}
        <div className="lg:col-span-4 space-y-8">
          
          {/* Active Positions */}
          <div className="glass-panel p-6">
            <SectionHeader 
              title="Active Positions" 
              subtitle={positions?.length ? `${positions.length} currently open` : 'No active exposure'} 
            />
            <div className="space-y-4 mt-6">
              {(positions ?? []).map((p) => (
                <div key={p.order_id} className="glass-card p-4 border-l-4 border-l-accent">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black text-white">{p.symbol}</span>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm ${p.side === 'LONG' ? 'bg-bull/20 text-bull' : 'bg-bear/20 text-bear'}`}>
                          {p.side} {p.leverage}x
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-500 font-mono mt-1">
                        {new Date(p.opened_at).toLocaleTimeString()}
                      </p>
                    </div>
                    <div className={`text-lg font-mono font-bold ${p.unrealized_pnl >= 0 ? 'text-bull text-glow-bull' : 'text-bear text-glow-bear'}`}>
                      {p.unrealized_pnl >= 0 ? '+' : ''}{p.unrealized_pnl.toFixed(2)}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-y-3 gap-x-4">
                    <div>
                      <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Entry</div>
                      <div className="text-xs font-mono text-gray-300">{p.entry_price.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Size (USDT)</div>
                      <div className="text-xs font-mono text-gray-300">{(p.qty * p.entry_price).toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Liq. Price</div>
                      <div className="text-xs font-mono text-bear">{p.liq_price?.toFixed(2) ?? '—'}</div>
                    </div>
                    <div>
                      <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Margin</div>
                      <div className="text-xs font-mono text-gray-300">{p.margin_usdt.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              ))}
              {(!positions || positions.length === 0) && (
                <div className="h-32 flex items-center justify-center border-2 border-dashed border-white/5 rounded-xl">
                  <span className="text-xs text-gray-600 font-mono italic">Market neutral · Waiting for signals</span>
                </div>
              )}
            </div>
          </div>

          {/* Detailed Performance Analytics */}
          <div className="glass-panel p-6">
            <SectionHeader title="Analytics" subtitle="Deep-dive performance metrics" />
            <div className="grid grid-cols-1 gap-4 mt-6">
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-xs text-gray-400">Total Volume</span>
                <span className="text-xs font-mono text-white">
                  {fmtUsdt((trades ?? []).reduce((acc, t) => acc + t.qty * t.entry_price, 0), 0)} USDT
                </span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-xs text-gray-400">Average Win</span>
                <span className="text-xs font-mono text-bull">+{fmtUsdt(stats?.avg_win ?? 0)} USDT</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-xs text-gray-400">Average Loss</span>
                <span className="text-xs font-mono text-bear">-{fmtUsdt(Math.abs(stats?.avg_loss ?? 0))} USDT</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-xs text-gray-400">Total Fees Paid</span>
                <span className="text-xs font-mono text-gray-400">{fmtUsdt(stats?.total_fees ?? 0)} USDT</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-white/5">
                <span className="text-xs text-gray-400">Total Funding</span>
                <span className={`text-xs font-mono ${(stats?.total_funding ?? 0) >= 0 ? 'text-bull' : 'text-bear'}`}>
                  {fmtUsdt(stats?.total_funding ?? 0)} USDT
                </span>
              </div>
              <div className="flex justify-between items-center py-2">
                <span className="text-xs text-gray-400">Efficiency</span>
                <span className="text-xs font-mono text-accent">High-Performance</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
