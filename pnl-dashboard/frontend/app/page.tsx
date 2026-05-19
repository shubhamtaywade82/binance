'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';
import { usePnLWebSocket } from '@/hooks/usePnLWebSocket';

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
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export default function UnifiedDashboard() {
  const { isConnected } = usePnLWebSocket();

  // API Hooks
  const { data: stats } = useSWR<TradeStats>('/trades/stats', swrFetcher, { refreshInterval: 10000 });
  const { data: equitySeries } = useSWR<EquityPoint[]>('/equity/curve?limit=1000', swrFetcher, { refreshInterval: 30000 });
  const { data: wallet } = useSWR<WalletState>('/wallet', swrFetcher, { refreshInterval: 10000 });
  const { data: fx } = useSWR<FxState>('/wallet/fx', swrFetcher, { refreshInterval: 60000 });
  const { data: positions } = useSWR<Position[]>('/positions', swrFetcher, { refreshInterval: 5000 });
  const { data: trades } = useSWR<Trade[]>('/trades?limit=100', swrFetcher, { refreshInterval: 10000 });

  const fxRate = wallet?.inr_per_usdt ?? fx?.inr_per_usdt ?? 85.5;

  // Filter States
  const [dateFilter, setDateFilter] = useState('all');
  const [symbolFilter, setSymbolFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [sideFilter, setSideFilter] = useState('all');

  const [appliedDate, setAppliedDate] = useState('all');
  const [appliedSymbol, setAppliedSymbol] = useState('all');
  const [appliedType, setAppliedType] = useState('all');
  const [appliedOutcome, setAppliedOutcome] = useState('all');
  const [appliedSide, setAppliedSide] = useState('all');

  const handleApplyFilters = () => {
    setAppliedDate(dateFilter);
    setAppliedSymbol(symbolFilter);
    setAppliedType(typeFilter);
    setAppliedOutcome(outcomeFilter);
    setAppliedSide(sideFilter);
  };

  const handleResetFilters = () => {
    setDateFilter('all');
    setSymbolFilter('all');
    setTypeFilter('all');
    setOutcomeFilter('all');
    setSideFilter('all');
    setAppliedDate('all');
    setAppliedSymbol('all');
    setAppliedType('all');
    setAppliedOutcome('all');
    setAppliedSide('all');
  };

  // Derived calculations for filters
  const uniqueSymbols = useMemo(() => {
    if (!trades) return ['all'];
    const syms = new Set(trades.map(t => t.symbol));
    return ['all', ...Array.from(syms)];
  }, [trades]);

  // Apply filters to list
  const filteredTrades = useMemo(() => {
    if (!trades) return [];
    return trades.filter(t => {
      // Date filter
      if (appliedDate !== 'all') {
        const tradeDate = new Date(t.timestamp_ms);
        const today = new Date();
        if (appliedDate === 'today' && tradeDate.toDateString() !== today.toDateString()) return false;
        if (appliedDate === 'yesterday') {
          const yesterday = new Date();
          yesterday.setDate(today.getDate() - 1);
          if (tradeDate.toDateString() !== yesterday.toDateString()) return false;
        }
      }
      // Symbol filter
      if (appliedSymbol !== 'all' && t.symbol !== appliedSymbol) return false;
      // Type/Side filter
      if (appliedType !== 'all') {
        if (appliedType === 'long' && t.side !== 'LONG') return false;
        if (appliedType === 'short' && t.side !== 'SHORT') return false;
      }
      // Side filter
      if (appliedSide !== 'all') {
        if (appliedSide === 'buy' && t.side !== 'LONG') return false;
        if (appliedSide === 'sell' && t.side !== 'SHORT') return false;
      }
      // Outcome filter
      if (appliedOutcome !== 'all') {
        if (appliedOutcome === 'win' && t.net_pnl <= 0) return false;
        if (appliedOutcome === 'loss' && t.net_pnl > 0) return false;
      }
      return true;
    });
  }, [trades, appliedDate, appliedSymbol, appliedType, appliedOutcome, appliedSide]);

  // Stats computed from filtered trades
  const filteredStats = useMemo(() => {
    const total = filteredTrades.length;
    const wins = filteredTrades.filter(t => t.net_pnl > 0).length;
    const losses = total - wins;
    const pnl = filteredTrades.reduce((acc, t) => acc + (t.net_pnl * fxRate), 0);
    return { total, wins, losses, pnl };
  }, [filteredTrades, fxRate]);

  // Derived Values
  const availableCashInr = wallet?.balance_inr ?? ((wallet?.balance ?? 0) * fxRate);
  const unrealizedPnlInr = wallet?.unrealized_pnl_inr ?? ((wallet?.unrealized_pnl ?? 0) * fxRate);
  const realizedPnlInr = wallet?.realized_pnl_inr ?? ((wallet?.realized_pnl ?? 0) * fxRate);
  const totalNetPnlInr = realizedPnlInr + unrealizedPnlInr;

  // High Water Mark (HWM) calculation
  const highWaterMarkInr = useMemo(() => {
    const equityInrs = (equitySeries ?? []).map(e => e.equity * fxRate);
    const maxHistorical = equityInrs.length > 0 ? Math.max(...equityInrs) : 0;
    return Math.max(maxHistorical, (wallet?.equity_inr ?? 0));
  }, [equitySeries, wallet, fxRate]);

  // Sparkline Generator for Total Net PnL card
  const renderSparkline = () => {
    if (!equitySeries || equitySeries.length < 2) {
      return (
        <svg width="40" height="12" className="overflow-visible opacity-50">
          <line x1="0" y1="6" x2="40" y2="6" stroke="#475569" strokeWidth="1" strokeDasharray="2 2" />
        </svg>
      );
    }
    const lastPoints = equitySeries.slice(-12);
    const min = Math.min(...lastPoints.map(p => p.equity));
    const max = Math.max(...lastPoints.map(p => p.equity));
    const range = max - min || 1;
    const width = 40;
    const height = 12;
    const coords = lastPoints.map((p, idx) => {
      const x = (idx / (lastPoints.length - 1)) * width;
      const y = height - ((p.equity - min) / range) * height;
      return `${x},${y}`;
    }).join(' ');
    const isProfit = totalNetPnlInr >= 0;
    return (
      <svg width={width} height={height} className="overflow-visible">
        <polyline
          fill="none"
          stroke={isProfit ? '#10b981' : '#ef4444'}
          strokeWidth="1.2"
          points={coords}
        />
      </svg>
    );
  };

  return (
    <div className="space-y-6 select-none animate-in fade-in duration-500">
      
      {/* Stats Row (7 Cards) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        {/* Card 1: AVAILABLE CASH */}
        <div className="bg-[#0b101d] border border-[#142037] p-3 rounded flex flex-col justify-between h-[85px] relative group hover:border-[#1e2e4f] transition-all">
          <span className="text-[9px] font-bold text-gray-500 tracking-wider">AVAILABLE CASH</span>
          <div className="text-sm font-black font-mono text-white mt-1">
            {fmtInr(availableCashInr)}
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981] animate-pulse" />
            <span className="text-[8px] font-bold text-emerald-400 tracking-widest">LIVE ACTIVE</span>
          </div>
        </div>

        {/* Card 2: TOTAL NET PNL */}
        <div className="bg-[#0b101d] border border-[#142037] p-3 rounded flex flex-col justify-between h-[85px] relative group hover:border-[#1e2e4f] transition-all">
          <span className="text-[9px] font-bold text-gray-500 tracking-wider">TOTAL NET PNL</span>
          <div className={`text-sm font-black font-mono mt-1 ${totalNetPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmtInr(totalNetPnlInr)}
          </div>
          <div className="flex items-center justify-between gap-1.5 mt-2">
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${totalNetPnlInr >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} />
              <span className="text-[8px] font-bold text-gray-400 tracking-widest">DAY PERFORMANCE</span>
            </div>
            {renderSparkline()}
          </div>
        </div>

        {/* Card 3: REALIZED */}
        <div className="bg-[#0b101d] border border-[#142037] p-3 rounded flex flex-col justify-between h-[85px] relative group hover:border-[#1e2e4f] transition-all">
          <span className="text-[9px] font-bold text-gray-500 tracking-wider">REALIZED</span>
          <div className={`text-sm font-black font-mono mt-1 ${realizedPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmtInr(realizedPnlInr)}
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-[8px] font-bold text-gray-400 tracking-widest">BOOKED PROFIT</span>
            <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
          </div>
        </div>

        {/* Card 4: ACTIVE UNREALIZED */}
        <div className="bg-[#0b101d] border border-[#142037] p-3 rounded flex flex-col justify-between h-[85px] relative group hover:border-[#1e2e4f] transition-all">
          <span className="text-[9px] font-bold text-gray-500 tracking-wider">ACTIVE UNREALIZED</span>
          <div className={`text-sm font-black font-mono mt-1 ${unrealizedPnlInr >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {fmtInr(unrealizedPnlInr)}
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 animate-pulse shadow-[0_0_6px_#06b6d4]" />
            <span className="text-[8px] font-bold text-cyan-400 tracking-widest">LIVE TRACKING</span>
          </div>
        </div>

        {/* Card 5: DAILY PEAK (HWM) */}
        <div className="bg-[#0b101d] border border-[#142037] p-3 rounded flex flex-col justify-between h-[85px] relative group hover:border-[#1e2e4f] transition-all">
          <span className="text-[9px] font-bold text-gray-500 tracking-wider">DAILY PEAK (HWM)</span>
          <div className="text-sm font-black font-mono text-white mt-1">
            {fmtInr(highWaterMarkInr)}
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span className="text-[8px] font-bold text-gray-400 tracking-widest">PROFIT CEILING</span>
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_6px_#a855f7]" />
          </div>
        </div>

        {/* Card 6: LIVE EXPOSURE */}
        <div className="bg-[#0b101d] border border-[#142037] p-3 rounded flex flex-col justify-between h-[85px] relative group hover:border-[#1e2e4f] transition-all">
          <span className="text-[9px] font-bold text-gray-500 tracking-wider">LIVE EXPOSURE</span>
          <div className="text-sm font-black font-mono text-white mt-1">
            {positions?.length ?? 0} ACTIVE
          </div>
          <div className="flex gap-0.5 mt-2">
            {[...Array(5)].map((_, i) => {
              const active = (positions?.length ?? 0) > i;
              return (
                <div
                  key={i}
                  className={`h-1.5 flex-1 rounded-sm ${active ? 'bg-cyan-500 shadow-[0_0_4px_#06b6d4]' : 'bg-[#18233c]'}`}
                />
              );
            })}
          </div>
        </div>

        {/* Card 7: DAY VOLUME */}
        <div className="bg-[#0b101d] border border-[#142037] p-3 rounded flex flex-col justify-between h-[85px] relative group hover:border-[#1e2e4f] transition-all">
          <span className="text-[9px] font-bold text-gray-500 tracking-wider">DAY VOLUME</span>
          <div className="text-sm font-black font-mono text-white mt-1">
            {stats?.total_trades ?? 0} TRADES
          </div>
          <div className="flex justify-between items-center gap-1 mt-2">
            <div className="flex gap-0.5">
              {[...Array(6)].map((_, i) => {
                const total = stats?.total_trades ?? 0;
                const active = total > i * 2;
                return (
                  <div
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500 shadow-[0_0_4px_#10b981]' : 'bg-[#18233c]'}`}
                  />
                );
              })}
            </div>
            <span className="text-[7px] font-bold text-gray-500">MAX_REQD</span>
          </div>
        </div>
      </div>

      {/* Main Grid: Open Positions & Completed Trades */}
      <div className="grid grid-cols-1 gap-6">
        
        {/* Panel 1: Open Positions */}
        <div className="bg-[#060913] border border-[#131b2d] rounded-lg overflow-hidden">
          <div className="bg-[#0b101d] px-4 py-3 flex items-center justify-between border-b border-[#131b2d]">
            <h2 className="text-xs font-bold text-white tracking-widest uppercase">
              OPEN POSITIONS [{positions?.length ?? 0}]
            </h2>
            <div className="flex items-center gap-2">
              <span className={`text-[8px] font-bold px-2 py-0.5 rounded border ${
                isConnected
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
              }`}>
                {isConnected ? 'WS LIVE' : 'WS STALE'}
              </span>
              <span className="text-[8px] font-bold px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-400 border-emerald-500/20">
                CIRCUIT: OPTIMAL
              </span>
            </div>
          </div>

          <div className="p-4 min-h-[140px] flex flex-col justify-center">
            {positions && positions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px] font-mono select-text">
                  <thead>
                    <tr className="border-b border-[#131b2d] text-gray-500 pb-2">
                      <th className="pb-2 font-bold uppercase tracking-wider">Asset</th>
                      <th className="pb-2 font-bold uppercase tracking-wider text-center">Side</th>
                      <th className="pb-2 font-bold uppercase tracking-wider text-right">Size</th>
                      <th className="pb-2 font-bold uppercase tracking-wider text-right">Entry Price</th>
                      <th className="pb-2 font-bold uppercase tracking-wider text-right">Net PnL</th>
                      <th className="pb-2 font-bold uppercase tracking-wider text-right">% PnL</th>
                      <th className="pb-2 font-bold uppercase tracking-wider text-right">Liq. Price</th>
                      <th className="pb-2 font-bold uppercase tracking-wider text-right">Margin</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#131b2d]">
                    {positions.map(p => {
                      const pnlPct = p.margin_usdt > 0 ? (p.unrealized_pnl / p.margin_usdt) * 100 : 0;
                      return (
                      <tr key={p.order_id} className="hover:bg-white/[0.01] transition-colors">
                        <td className="py-3 font-bold text-white">{p.symbol}</td>
                        <td className="py-3 text-center">
                          <span className={`px-2 py-0.5 rounded-sm font-bold text-[9px] ${
                            p.side === 'LONG'
                              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                              : 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
                          }`}>
                            {p.side} {p.leverage}x
                          </span>
                        </td>
                        <td className="py-3 text-right text-gray-300">{(p.qty * p.entry_price).toFixed(2)} USDT</td>
                        <td className="py-3 text-right text-gray-400">{p.entry_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                        <td className={`py-3 text-right font-bold ${p.unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {p.unrealized_pnl >= 0 ? '+' : ''}{(p.unrealized_pnl * fxRate).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
                        </td>
                        <td className={`py-3 text-right font-bold ${pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
                        </td>
                        <td className="py-3 text-right text-rose-500">{p.liq_price ? p.liq_price.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—'}</td>
                        <td className="py-3 text-right text-gray-300">{(p.margin_usdt * fxRate).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-6">
                <div className="relative w-12 h-12 flex items-center justify-center mb-3">
                  <div className="absolute inset-0 rounded-full border border-cyan-500/20 animate-ping duration-1000" />
                  <div className="absolute inset-0.5 rounded-full border border-cyan-500/30" />
                  <svg className="w-5 h-5 text-cyan-400 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <span className="text-[10px] font-black text-cyan-400 tracking-widest uppercase animate-pulse">
                  SCANNING FOR ENTRIES...
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Panel 2: Completed Trades */}
        <div className="bg-[#060913] border border-[#131b2d] rounded-lg overflow-hidden">
          <div className="bg-[#0b101d] px-4 py-3 border-b border-[#131b2d] flex items-center justify-between">
            <h2 className="text-xs font-bold text-white tracking-widest uppercase">
              COMPLETED TRADES [{filteredTrades.length}]
            </h2>
          </div>

          {/* Filters Bar */}
          <div className="p-4 border-b border-[#131b2d] space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {/* Date */}
              <div className="flex flex-col gap-1">
                <label className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">Date</label>
                <select
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value)}
                  className="bg-[#0d1222] border border-[#131b2d] rounded px-3 py-1.5 text-[10px] text-gray-300 font-bold focus:outline-none focus:border-[#1e2e4f] cursor-pointer"
                >
                  <option value="all">ALL</option>
                  <option value="today">TODAY</option>
                  <option value="yesterday">YESTERDAY</option>
                </select>
              </div>

              {/* Index/Symbol */}
              <div className="flex flex-col gap-1">
                <label className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">Index/Symbol</label>
                <select
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  className="bg-[#0d1222] border border-[#131b2d] rounded px-3 py-1.5 text-[10px] text-gray-300 font-bold focus:outline-none focus:border-[#1e2e4f] cursor-pointer"
                >
                  {uniqueSymbols.map(sym => (
                    <option key={sym} value={sym}>{sym.toUpperCase()}</option>
                  ))}
                </select>
              </div>

              {/* Type */}
              <div className="flex flex-col gap-1">
                <label className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">Type</label>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                  className="bg-[#0d1222] border border-[#131b2d] rounded px-3 py-1.5 text-[10px] text-gray-300 font-bold focus:outline-none focus:border-[#1e2e4f] cursor-pointer"
                >
                  <option value="all">ALL</option>
                  <option value="long">LONG</option>
                  <option value="short">SHORT</option>
                </select>
              </div>

              {/* Outcome */}
              <div className="flex flex-col gap-1">
                <label className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">Outcome</label>
                <select
                  value={outcomeFilter}
                  onChange={(e) => setOutcomeFilter(e.target.value)}
                  className="bg-[#0d1222] border border-[#131b2d] rounded px-3 py-1.5 text-[10px] text-gray-300 font-bold focus:outline-none focus:border-[#1e2e4f] cursor-pointer"
                >
                  <option value="all">ALL</option>
                  <option value="win">WIN</option>
                  <option value="loss">LOSS</option>
                </select>
              </div>

              {/* Sides */}
              <div className="flex flex-col gap-1">
                <label className="text-[8px] font-bold text-gray-500 uppercase tracking-widest">Sides</label>
                <select
                  value={sideFilter}
                  onChange={(e) => setSideFilter(e.target.value)}
                  className="bg-[#0d1222] border border-[#131b2d] rounded px-3 py-1.5 text-[10px] text-gray-300 font-bold focus:outline-none focus:border-[#1e2e4f] cursor-pointer"
                >
                  <option value="all">ALL</option>
                  <option value="buy">BUY</option>
                  <option value="sell">SELL</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={handleResetFilters}
                className="px-4 py-1.5 border border-[#142037] hover:bg-white/5 rounded text-[10px] font-bold text-gray-400 transition"
              >
                RESET
              </button>
              <button
                onClick={handleApplyFilters}
                className="px-4 py-1.5 bg-emerald-500 text-black font-black rounded text-[10px] tracking-wider transition hover:bg-emerald-400"
              >
                APPLY
              </button>
            </div>
          </div>

          {/* Filter Stats Output */}
          <div className="bg-[#060913] border-b border-[#131b2d] px-4 py-2 text-[10px] font-bold tracking-widest text-[#6c7d9c] flex flex-wrap gap-x-6 gap-y-1">
            <span>FILTERED SUMMARY:</span>
            <span>{filteredStats.total} TRADES</span>
            <span className="text-emerald-400">{filteredStats.wins} WINS</span>
            <span className="text-rose-400">{filteredStats.losses} LOSSES</span>
            <span className={filteredStats.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              NET: {fmtInr(filteredStats.pnl)}
            </span>
          </div>

          {/* Table */}
          <div className="p-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[11px] font-mono select-text">
                <thead>
                  <tr className="border-b border-[#131b2d] text-gray-500 pb-2">
                    <th className="pb-2 font-bold uppercase tracking-wider">Asset</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-center">Side</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-right">Qty</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-right">Entry</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-right">Exit</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-right">Net PnL</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-right">% PnL</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-center">Source</th>
                    <th className="pb-2 font-bold uppercase tracking-wider text-right">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#131b2d]">
                  {filteredTrades.map(t => {
                    const sideClass = t.side === 'LONG'
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
                    const sideLabel = t.side === 'LONG' ? 'LONG PE' : 'SHORT PE';
                    
                    const pctPnL = ((t.exit_price - t.entry_price) / t.entry_price) * 100 * (t.side === 'LONG' ? 1 : -1) * (t.leverage ?? 1);
                    const netPnLInr = t.net_pnl * fxRate;
                    
                    return (
                      <tr key={t.id} className="hover:bg-white/[0.01] transition-colors">
                        <td className="py-2.5 font-bold text-white">{t.symbol}</td>
                        <td className="py-2.5 text-center">
                          <span className={`px-2 py-0.5 rounded-sm font-bold text-[8px] ${sideClass}`}>
                            {sideLabel}
                          </span>
                        </td>
                        <td className="py-2.5 text-right text-gray-300">{t.qty.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td>
                        <td className="py-2.5 text-right text-gray-400">{t.entry_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                        <td className="py-2.5 text-right text-gray-400">{t.exit_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                        <td className={`py-2.5 text-right font-bold ${netPnLInr >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {netPnLInr >= 0 ? '+' : ''}{netPnLInr.toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 })}
                        </td>
                        <td className={`py-2.5 text-right font-bold ${pctPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {pctPnL >= 0 ? '+' : ''}{pctPnL.toFixed(2)}%
                        </td>
                        <td className="py-2.5 text-center">
                          <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-400 text-[8px] font-bold uppercase">
                            {t.close_reason || 'EXIT'}
                          </span>
                        </td>
                        <td className="py-2.5 text-right text-gray-500">
                          {new Date(t.timestamp_ms).toLocaleTimeString()}
                        </td>
                      </tr>
                    );
                  })}
                  {filteredTrades.length === 0 && (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-gray-500 font-bold italic">
                        No completed trades match selected filters
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </div>

      {/* Bottom Vault Status Bar */}
      <div className="bg-[#0b101d] border border-[#142037] px-4 py-2 rounded flex items-center justify-between text-[8px] font-black tracking-widest text-[#6c7d9c]">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_6px_#22d3ee]" />
          VAULT SYNC ACTIVE
        </div>
        <div>
          REFRESHED: {new Date().toLocaleTimeString()}
        </div>
      </div>

    </div>
  );
}
