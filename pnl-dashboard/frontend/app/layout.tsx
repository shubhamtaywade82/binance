import type { Metadata } from 'next';
import './globals.css';
import LiveUpdates from '../components/LiveUpdates';
import Toaster from '../components/Toaster';
import Header from '../components/Header';

export const metadata: Metadata = {
  title: 'PnL Dashboard',
  description: 'Paper trading performance dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <LiveUpdates />
        <Toaster />
        <Header />
        <main className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
