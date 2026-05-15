'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import { swrFetcher } from '@/lib/api';
import { downsampleSeries, formatAxisTimestamp, numericSeriesDomain } from '@/lib/chart-utils';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from 'recharts';

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

const fmtInr = (v: number): string => {
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const fmtUsdt = (v: number, digits = 2): string => {
  const sign = v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toFixed(digits)}`;
};

/** USDT primary (trading), INR secondary — avoids cramped ₹-only lines in narrow cards. */
function MoneyCard({
  label,
  usdt,
  inr,
  color,
}: {
  label: string;
  usdt: number;
  inr: number;
  color?: string;
}) {
  const inrLine = fmtInr(inr);
  return (
    <div className="bg-bg-card rounded-lg border border-white/5 p-3 sm:p-4 min-w-0 flex flex-col gap-1">
      <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wider truncate" title={label}>
        {label}
      </div>
      <div className={`text-base sm:text-lg md:text-xl font-mono tabular-nums leading-snug ${color || 'text-white'}`}>
        <span className="break-all">{fmtUsdt(usdt)}</span>
        <span className="text-gray-500 font-normal text-xs sm:text-sm ml-1">USDT</span>
      </div>
      <div className="text-[11px] sm:text-xs font-mono text-gray-400 truncate" title={inrLine}>
        ≈ {inrLine}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-bg-card rounded-lg border border-white/5 p-3 sm:p-4 min-w-0">
      <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wider truncate">{label}</div>
      <div className={`text-base sm:text-xl font-mono tabular-nums mt-1 break-words ${color || 'text-white'}`}>
        {value}
      </div>
    </div>
  );
}

const ddColor = (pct: number): string => {
  if (pct >= -2) return 'text-bull';
  if (pct >= -5) return 'text-amber-400';
  return 'text-bear';
};

const riskTier = (pct: number): 'SAFE' | 'WARN' | 'CRIT' => {
  if (pct >= -2) return 'SAFE';
  if (pct >= -5) return 'WARN';
  return 'CRIT';
};

const riskPillClass = (tier: string): string => {
  if (tier === 'SAFE') return 'bg-bull/20 text-bull';
  if (tier === 'WARN') return 'bg-amber-500/20 text-amber-400';
  return 'bg-bear/20 text-bear';
};

export default function OverviewPage() {
  const { data: stats } = useSWR<TradeStats>('/trades/stats', swrFetcher, { refreshInterval: 5000 });
  const { data: equity } = useSWR<EquityPoint[]>('/equity/curve?limit=500', swrFetcher, { refreshInterval: 10000 });
  const { data: wallet } = useSWR<WalletState>('/wallet', swrFetcher, { refreshInterval: 3000 });
  const { data: fx } = useSWR<FxState>('/wallet/fx', swrFetcher, { refreshInterval: 30000 });

  const pnlColor = (stats?.total_pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear';

  const lastEq = equity && equity.length > 0 ? equity[equity.length - 1] : null;
  const ddPct = lastEq ? lastEq.drawdown : 0;
  const tier = riskTier(ddPct);

  const fxRate = wallet?.inr_per_usdt ?? fx?.inr_per_usdt ?? 85;
  const fxSource = fx?.source ?? 'fallback';

  const w = wallet;
  const unrealColor = (w?.unrealized_pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear';
  const realColor = (w?.realized_pnl ?? 0) >= 0 ? 'text-bull' : 'text-bear';

  const chartEquity = useMemo(() => downsampleSeries(equity ?? [], 72), [equity]);
  const equityYDomain = useMemo(() => {
    const vals = (equity ?? []).map((e) => e.equity);
    if (vals.length === 0) return [9_500, 10_500] as [number, number];
    return numericSeriesDomain(vals, 0.05);
  }, [equity]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold">Overview</h1>
        <div className="text-xs text-gray-400 font-mono bg-bg-card border border-white/5 rounded-lg px-3 py-2 max-w-full">
          <span className="text-gray-300">1 USDT</span> = {fmtInr(fxRate)}{' '}
          <span className="text-gray-600">({fxSource})</span>
        </div>
      </div>

      <section aria-label="Wallet">
        <h2 className="sr-only">Wallet snapshot</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
          <MoneyCard label="Equity" usdt={w?.equity ?? 0} inr={w?.equity_inr ?? 0} />
          <MoneyCard label="Wallet" usdt={w?.balance ?? 0} inr={w?.balance_inr ?? 0} />
          <MoneyCard label="Unrealized" usdt={w?.unrealized_pnl ?? 0} inr={w?.unrealized_pnl_inr ?? 0} color={unrealColor} />
          <MoneyCard label="Realized (net)" usdt={w?.realized_pnl ?? 0} inr={w?.realized_pnl_inr ?? 0} color={realColor} />
          <StatCard label="Drawdown" value={`${ddPct.toFixed(2)}%`} color={ddColor(ddPct)} />
          <div className="bg-bg-card rounded-lg border border-white/5 p-3 sm:p-4 min-w-0 flex flex-col justify-center">
            <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wider">Risk</div>
            <div className="mt-2">
              <span className={`inline-block px-3 py-1.5 rounded-full font-mono text-sm ${riskPillClass(tier)}`}>
                {tier}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section aria-label="Performance">
        <h2 className="text-sm text-gray-500 mb-3">Performance</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <StatCard label="Total PnL" value={`${(stats?.total_pnl ?? 0).toFixed(2)} USDT`} color={pnlColor} />
          <StatCard label="Win rate" value={`${((stats?.win_rate ?? 0) * 100).toFixed(1)}%`} />
          <StatCard label="Total trades" value={String(stats?.total_trades ?? 0)} />
          <StatCard label="Profit factor" value={(stats?.profit_factor ?? 0).toFixed(2)} />
        </div>
      </section>

      <div className="bg-bg-card rounded-lg border border-white/5 p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <h2 className="text-sm font-medium text-gray-300">Equity curve</h2>
          <span className="text-xs text-gray-500 font-mono hidden sm:inline">
            {chartEquity.length} pts shown
            {(equity?.length ?? 0) > chartEquity.length ? ` · ${equity?.length} total` : ''}
          </span>
        </div>
        <p className="text-xs text-gray-500 mb-4">USDT equity over time (sampled for readability).</p>
        <div className="w-full" style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartEquity} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
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
                domain={equityYDomain}
                tickFormatter={(v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                width={56}
              />
              <Tooltip
                contentStyle={{
                  background: '#161b22',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(t: number) => new Date(t).toLocaleString()}
                formatter={(value: number) => [
                  `${fmtUsdt(value)} USDT (≈ ${fmtInr(value * fxRate)})`,
                  'Equity',
                ]}
              />
              <Line type="monotone" dataKey="equity" stroke="#00e676" dot={false} strokeWidth={2} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
