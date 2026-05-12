import dotenv from 'dotenv';

dotenv.config();

type Check = { name: string; ok: boolean; details: string };

const bool = (value: string | undefined, fallback = false): boolean => {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const checks: Check[] = [];

const executionMode = (process.env.EXECUTION_MODE || 'paper').toLowerCase();
checks.push({
  name: 'Execution mode safety',
  ok: executionMode === 'paper',
  details:
    executionMode === 'paper'
      ? 'Paper mode is enabled (safe for dry run before live capital).'
      : `EXECUTION_MODE=${executionMode}. This app only supports live exchange orders via CoinDCX adapter.`,
});

const placeOrder = bool(process.env.PLACE_ORDER, true);
checks.push({
  name: 'PLACE_ORDER toggle',
  ok: placeOrder,
  details: placeOrder
    ? 'PLACE_ORDER=true, strategy can open/close positions in adapter.'
    : 'PLACE_ORDER=false, signals-only mode. No positions will be executed.',
});

const readOnly = bool(process.env.READ_ONLY, true);
checks.push({
  name: 'READ_ONLY guardrail',
  ok: readOnly,
  details: readOnly
    ? 'READ_ONLY=true, protects against accidental live execution.'
    : 'READ_ONLY=false, live execution can occur if EXECUTION_MODE=live and keys exist.',
});

const symbol = process.env.BINANCE_SYMBOL || (process.env.TRADING_ASSET || 'sol').toUpperCase() + 'USDT';
checks.push({
  name: 'Trading symbol',
  ok: /USDT$/i.test(symbol),
  details: `Resolved symbol: ${symbol}`,
});

const timeframes = (process.env.BINANCE_TIMEFRAMES || '5m,15m,1h,4h,1d').split(',').map((s) => s.trim());
checks.push({
  name: 'Multi-timeframe stack',
  ok: ['5m', '15m', '1h', '4h', '1d'].every((tf) => timeframes.includes(tf)),
  details: `Configured timeframes: ${timeframes.join(', ')}`,
});

const tp = Number(process.env.TP_PRICE_PCT || '0.015');
const sl = Number(process.env.SL_PRICE_PCT || '0.01');
checks.push({
  name: '1.5% capture target',
  ok: Math.abs(tp - 0.015) < 1e-6,
  details: `TP_PRICE_PCT=${tp} (expected 0.015 for 1.5% target), SL_PRICE_PCT=${sl}`,
});

const wsBase = process.env.BINANCE_WS_BASE || 'wss://fstream.binance.com';
const restBase = process.env.BINANCE_REST_BASE || (bool(process.env.BINANCE_FUTURES_TESTNET) ? 'https://demo-fapi.binance.com' : 'https://fapi.binance.com');
checks.push({
  name: 'Binance futures endpoints',
  ok: wsBase.includes('fstream.binance') || wsBase.includes('binancefuture.com'),
  details: `REST=${restBase}, WS=${wsBase}`,
});

const pass = checks.filter((c) => c.ok).length;
const fail = checks.length - pass;

console.log('=== Binance SOL Futures Readiness ===');
for (const c of checks) {
  console.log(`${c.ok ? '✅' : '⚠️'} ${c.name}: ${c.details}`);
}
console.log(`\nSummary: ${pass}/${checks.length} checks passed, ${fail} flagged.`);
console.log('Note: Live Binance order routing is not wired in this repo. Keep EXECUTION_MODE=paper unless using CoinDCX live adapter.');
