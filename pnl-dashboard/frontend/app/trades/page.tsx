'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';

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

interface WalletState {
  inr_per_usdt: number;
}

export default function TradesPage() {
  const { data: trades } = useSWR<Trade[]>('/trades?limit=200', swrFetcher, { refreshInterval: 10000 });
  const { data: wallet } = useSWR<WalletState>('/wallet', swrFetcher, { refreshInterval: 10000 });

  const fxRate = wallet?.inr_per_usdt ?? 85.5;

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

  const uniqueSymbols = useMemo(() => {
    if (!trades) return ['all'];
    const syms = new Set(trades.map(t => t.symbol));
    return ['all', ...Array.from(syms)];
  }, [trades]);

  const filteredTrades = useMemo(() => {
    if (!trades) return [];
    return trades.filter(t => {
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
      if (appliedSymbol !== 'all' && t.symbol !== appliedSymbol) return false;
      if (appliedType !== 'all') {
        if (appliedType === 'long' && t.side !== 'LONG') return false;
        if (appliedType === 'short' && t.side !== 'SHORT') return false;
      }
      if (appliedSide !== 'all') {
        if (appliedSide === 'buy' && t.side !== 'LONG') return false;
        if (appliedSide === 'sell' && t.side !== 'SHORT') return false;
      }
      if (appliedOutcome !== 'all') {
        if (appliedOutcome === 'win' && t.net_pnl <= 0) return false;
        if (appliedOutcome === 'loss' && t.net_pnl > 0) return false;
      }
      return true;
    });
  }, [trades, appliedDate, appliedSymbol, appliedType, appliedOutcome, appliedSide]);

  const filteredStats = useMemo(() => {
    const total = filteredTrades.length;
    const wins = filteredTrades.filter(t => t.net_pnl > 0).length;
    const losses = total - wins;
    const pnl = filteredTrades.reduce((acc, t) => acc + (t.net_pnl * fxRate), 0);
    return { total, wins, losses, pnl };
  }, [filteredTrades, fxRate]);

  return (
    <div className="space-y-6 select-none animate-in fade-in duration-500">
      <div>
        <h1 className="text-xl font-bold text-white tracking-wider uppercase">HISTORICAL SIGNALS & EXECUTION</h1>
        <p className="text-xs text-gray-500">Audit logs of completed trades up to last 200 records</p>
      </div>

      <div className="bg-[#060913] border border-[#131b2d] rounded-lg overflow-hidden">
        <div className="bg-[#0b101d] px-4 py-3 border-b border-[#131b2d] flex items-center justify-between">
          <h2 className="text-xs font-bold text-white tracking-widest uppercase">
            COMPLETED TRADES LOG [{filteredTrades.length}]
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
            NET: {filteredStats.pnl.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
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
                        {new Date(t.timestamp_ms).toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
                {filteredTrades.length === 0 && (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-gray-500 font-bold italic">
                      No completed trades found matching selected filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
