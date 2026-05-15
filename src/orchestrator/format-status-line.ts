/**
 * Pure formatter for the one-line paper-trading heartbeat status banner.
 *
 * Format:
 *   EQ: ₹<inr> (<usdt> USDT) │ WAL: ₹<inr> (<usdt> USDT) │ UR: ₹<inr> (<usdt> USDT) │
 *   NET: ₹<inr> │ UNREAL USDT: <usdt> │ DD: <pct>% │ RISK: <TIER>
 */

export type RiskTier = 'SAFE' | 'WARN' | 'CRIT';

export interface StatusLineInput {
  /** Total equity (balance + unrealized PnL), in USDT. */
  equityUsdt: number;
  /** Wallet balance (cash), in USDT. */
  balanceUsdt: number;
  /** Unrealized PnL (signed), in USDT. */
  unrealizedPnlUsdt: number;
  /** Realized PnL (signed, session), in USDT. */
  realizedPnlUsdt: number;
  /** Drawdown vs session peak equity, percent (negative when below peak). */
  drawdownPct: number;
  /** INR per USDT FX rate. */
  inrPerUsdt: number;
}

const fmtInr = (usdt: number, inrPerUsdt: number): string => {
  const v = usdt * inrPerUsdt;
  const sign = v < 0 ? '-' : '';
  return `${sign}₹${Math.abs(v).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const fmtUsdt = (v: number): string => {
  const sign = v < 0 ? '-' : '';
  return `${sign}${Math.abs(v).toFixed(2)}`;
};

export const riskTierFor = (drawdownPct: number): RiskTier => {
  if (drawdownPct >= -2) return 'SAFE';
  if (drawdownPct >= -5) return 'WARN';
  return 'CRIT';
};

export const formatStatusLine = (s: StatusLineInput): string => {
  const fx = s.inrPerUsdt;
  const tier = riskTierFor(s.drawdownPct);
  const ddSign = s.drawdownPct < 0 ? '-' : '';
  const dd = `${ddSign}${Math.abs(s.drawdownPct).toFixed(2)}%`;
  return (
    `EQ: ${fmtInr(s.equityUsdt, fx)} (${fmtUsdt(s.equityUsdt)} USDT) │ ` +
    `WAL: ${fmtInr(s.balanceUsdt, fx)} (${fmtUsdt(s.balanceUsdt)} USDT) │ ` +
    `UR: ${fmtInr(s.unrealizedPnlUsdt, fx)} (${fmtUsdt(s.unrealizedPnlUsdt)} USDT) │ ` +
    `NET: ${fmtInr(s.realizedPnlUsdt, fx)} │ ` +
    `UNREAL USDT: ${fmtUsdt(s.unrealizedPnlUsdt)} │ ` +
    `DD: ${dd} │ ` +
    `RISK: ${tier}`
  );
};
