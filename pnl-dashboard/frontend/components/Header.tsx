'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { usePnLWebSocket } from '../hooks/usePnLWebSocket';

interface TickerPrice {
  symbol: string;
  price: string;
}

export default function Header() {
  const pathname = usePathname();
  const { isConnected } = usePnLWebSocket();
  const [prices, setPrices] = useState<Record<string, number>>({
    BTCUSDT: 67422.50,
    ETHUSDT: 3580.15,
    SOLUSDT: 168.45
  });

  useEffect(() => {
    const fetchPrices = async () => {
      try {
        const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BTCUSDT%22,%22ETHUSDT%22,%22SOLUSDT%22%5D');
        if (res.ok) {
          const data: TickerPrice[] = await res.json();
          const newPrices: Record<string, number> = {};
          data.forEach(item => {
            newPrices[item.symbol] = parseFloat(item.price);
          });
          setPrices(prev => ({ ...prev, ...newPrices }));
        }
      } catch (err) {
        console.warn('Failed to fetch public Binance prices, using default/cached values', err);
      }
    };

    fetchPrices();
    const interval = setInterval(fetchPrices, 8000);
    return () => clearInterval(interval);
  }, []);

  const formatDate = () => {
    const d = new Date();
    return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  };

  const navLinks = [
    { href: '/', label: 'TERMINAL' },
    { href: '/positions', label: 'STRATEGIES' },
    { href: '/trades', label: 'SIGNALS' },
    { href: '/analytics', label: 'ANALYSIS' },
  ];

  return (
    <header className="border-b border-white/5 bg-[#060913] text-gray-200 sticky top-0 z-50 px-4 py-2 flex flex-col md:flex-row items-center justify-between gap-4 select-none">
      {/* Top Left: Logo & Crypto Index Feeds */}
      <div className="flex flex-wrap items-center gap-6 w-full md:w-auto">
        <div className="flex flex-col">
          <span className="text-[10px] font-black text-accent tracking-widest leading-none">ENGINE</span>
          <span className="text-xs font-light text-gray-400 tracking-tighter">ACTIVE TERMINAL</span>
        </div>

        {/* Index Feeds */}
        <div className="flex items-center gap-4 text-xs font-mono">
          {/* BTC */}
          <div className="flex flex-col border-l border-white/10 pl-4">
            <span className="text-[9px] text-gray-500 font-bold tracking-wider">BTCUSDT</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-white font-bold tracking-tight">${prices.BTCUSDT.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
              <span className="text-[8px] px-1 py-0.2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded font-black">
                LIVE
              </span>
            </div>
            <span className="text-[8px] text-gray-600 mt-0.5">{formatDate()}</span>
          </div>

          {/* ETH */}
          <div className="flex flex-col border-l border-white/10 pl-4">
            <span className="text-[9px] text-gray-500 font-bold tracking-wider">ETHUSDT</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-white font-bold tracking-tight">${prices.ETHUSDT.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
              <span className="text-[8px] px-1 py-0.2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded font-black">
                LIVE
              </span>
            </div>
            <span className="text-[8px] text-gray-600 mt-0.5">{formatDate()}</span>
          </div>

          {/* SOL */}
          <div className="flex flex-col border-l border-white/10 pl-4">
            <span className="text-[9px] text-gray-500 font-bold tracking-wider">SOLUSDT</span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-white font-bold tracking-tight">${prices.SOLUSDT.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
              <span className="text-[8px] px-1 py-0.2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded font-black">
                LIVE
              </span>
            </div>
            <span className="text-[8px] text-gray-600 mt-0.5">{formatDate()}</span>
          </div>
        </div>
      </div>

      {/* Top Center: Navigation Tab Switcher */}
      <div className="flex items-center bg-[#0d1222] border border-white/5 p-1 rounded-lg">
        {navLinks.map(link => {
          const isActive = pathname === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`px-4 py-1.5 rounded-md text-[10px] font-black tracking-widest transition-all duration-200 ${
                isActive
                  ? 'bg-white/5 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] border border-white/10 font-bold'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}
            >
              {link.label}
            </Link>
          );
        })}
        <span className="px-4 py-1.5 text-[10px] font-black tracking-widest text-gray-600 cursor-not-allowed border border-transparent">
          SETTINGS
        </span>
      </div>

      {/* Top Right: Status indicators & Connection light */}
      <div className="flex items-center gap-6">
        <div className="hidden lg:flex items-center gap-4 text-[8px] font-black tracking-widest text-gray-500">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            NET IDENTITY
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            MD FEED
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            STG ENGINE
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            PNL UPDATER
          </div>
        </div>

        {/* Connected Badge */}
        <div className={`flex items-center gap-2 px-3 py-1 rounded-full border text-[9px] font-black tracking-wider uppercase ${
          isConnected
            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            : 'bg-rose-500/10 text-rose-400 border-rose-500/20 animate-pulse'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`} />
          {isConnected ? 'CONNECTED' : 'DISCONNECTED'}
        </div>
      </div>
    </header>
  );
}
