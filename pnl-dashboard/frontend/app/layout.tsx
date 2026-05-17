import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import LiveUpdates from '../components/LiveUpdates';

export const metadata: Metadata = {
  title: 'PnL Dashboard',
  description: 'Paper trading performance dashboard',
};

const navLinks = [
  { href: '/', label: 'Overview' },
  { href: '/trades', label: 'Trades' },
  { href: '/positions', label: 'Positions' },
  { href: '/analytics', label: 'Analytics' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <LiveUpdates />
        <header className="border-b border-white/5 bg-bg-panel/40 backdrop-blur-md sticky top-0 z-50">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
            <div className="flex items-center gap-4">
              <span className="font-black text-xl tracking-tighter text-white">
                ANTIGRAVITY<span className="text-accent italic font-light ml-1">TERMINAL</span>
              </span>
              <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full bg-bull/10 border border-bull/20">
                <div className="w-2 h-2 rounded-full bg-bull animate-pulse" />
                <span className="text-[10px] font-bold text-bull uppercase tracking-widest">Live Engine</span>
              </div>
            </div>
            <div className="flex items-center gap-6">
              <span className="text-xs text-gray-500 font-mono hidden md:block">
                v0.1.0-alpha · Binance Hybrid Core
              </span>
            </div>
          </div>
        </header>
        <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
