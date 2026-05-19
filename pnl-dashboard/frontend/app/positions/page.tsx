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

interface WalletState {
  inr_per_usdt: number;
}

export default function PositionsPage() {
  const { data: positions } = useSWR<Position[]>('/positions', swrFetcher, { refreshInterval: 5000 });
  const { data: wallet } = useSWR<WalletState>('/wallet', swrFetcher, { refreshInterval: 10000 });

  const fxRate = wallet?.inr_per_usdt ?? 85.5;

  return (
    <div className="space-y-6 select-none animate-in fade-in duration-500">
      <div>
        <h1 className="text-xl font-bold text-white tracking-wider uppercase">ACTIVE STRATEGIES & POSITIONS</h1>
        <p className="text-xs text-gray-500">Currently open exposure on Binance Futures</p>
      </div>

      {(!positions || positions.length === 0) ? (
        <div className="bg-[#060913] border border-[#131b2d] rounded-lg p-16 flex flex-col items-center justify-center min-h-[250px]">
          <div className="relative w-16 h-16 flex items-center justify-center mb-4">
            <div className="absolute inset-0 rounded-full border border-cyan-500/20 animate-ping duration-1000" />
            <div className="absolute inset-0.5 rounded-full border border-cyan-500/30" />
            <svg className="w-6 h-6 text-cyan-400 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="text-xs font-black text-cyan-400 tracking-widest uppercase animate-pulse mb-1">
            SCANNING FOR STRATEGY ENTRIES...
          </span>
          <span className="text-[10px] text-gray-600 font-mono">Market Neutral · Delta Zero</span>
        </div>
      ) : (
        <div className="grid gap-4">
          {positions.map(p => {
            const sideClass = p.side === 'LONG'
              ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
              : 'bg-rose-500/10 text-rose-400 border border-rose-500/20';
            const pnlInr = p.unrealized_pnl * fxRate;
            // ROE-style PnL %: unrealized PnL relative to margin posted. On a
            // 10x position a 1% adverse price move equals -10% on margin.
            const pnlPct = p.margin_usdt > 0 ? (p.unrealized_pnl / p.margin_usdt) * 100 : 0;
            return (
              <div key={p.order_id} className="bg-[#060913] border border-[#131b2d] rounded-lg overflow-hidden group hover:border-[#1e2e4f] transition-all">
                <div className="bg-[#0b101d] px-4 py-3 flex items-center justify-between border-b border-[#131b2d]">
                  <div className="flex items-center gap-3">
                    <span className="font-bold text-white tracking-wide text-xs">{p.symbol}</span>
                    <span className={`text-[9px] font-black px-2 py-0.5 rounded-sm ${sideClass}`}>
                      {p.side} {p.leverage}x
                    </span>
                    {p.tier ? (
                      <span className="text-[8px] font-black px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-gray-400 uppercase tracking-widest">
                        {p.tier}
                      </span>
                    ) : null}
                  </div>
                  <div className={`font-mono font-black text-sm tracking-tight ${p.unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {p.unrealized_pnl >= 0 ? '+' : ''}{pnlInr.toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}
                    <span className="text-[10px] font-bold text-gray-500 ml-2">
                      ({p.unrealized_pnl >= 0 ? '+' : ''}{p.unrealized_pnl.toFixed(2)} USDT)
                    </span>
                    <span className={`text-[10px] font-bold ml-2 ${pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                    </span>
                  </div>
                </div>
                <div className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-[11px] font-mono">
                  <div>
                    <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Entry Price</div>
                    <div className="text-gray-300">${p.entry_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Quantity</div>
                    <div className="text-gray-300">{p.qty.toLocaleString('en-US', { maximumFractionDigits: 4 })}</div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Margin Size</div>
                    <div className="text-gray-300">
                      ₹{(p.margin_usdt * fxRate).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      <span className="text-[9px] text-gray-500 ml-1">(${p.margin_usdt.toFixed(2)})</span>
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Liq Price</div>
                    <div className="text-rose-500 font-bold">
                      {p.liq_price ? `$${p.liq_price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] uppercase font-bold text-gray-600 mb-0.5">Opened Time</div>
                    <div className="text-gray-500">{new Date(p.opened_at).toLocaleTimeString()}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
