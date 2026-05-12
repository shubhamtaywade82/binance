/**
 * Logs USD-M perpetual "LTP" (last traded price) from Binance **futures REST** only.
 * Uses the same `fapi` host as when `fstream` WebSocket is blocked but HTTPS works.
 *
 * Usage:
 *   npm run futures:ltp:rest
 *   npm run futures:ltp:rest -- ETHUSDT
 *
 * Env:
 *   BINANCE_REST_BASE=https://fapi.binance.com  (default)
 *   FUTURES_LTP_POLL_SEC=1   (interval between log lines)
 */
import axios from 'axios';

const REST_BASE = (process.env.BINANCE_REST_BASE ?? 'https://fapi.binance.com').replace(/\/$/, '');
const symbol = (process.argv[2] ?? 'SOLUSDT').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
const pollSec = Math.max(0.2, Number.parseFloat(process.env.FUTURES_LTP_POLL_SEC ?? '1') || 1);

if (!symbol) {
  console.error('Usage: npm run futures:ltp:rest -- [SYMBOL]');
  process.exit(1);
}

interface Ticker24h {
  symbol?: string;
  lastPrice?: string;
  lastQty?: string;
  closeTime?: number;
}

interface Premium {
  symbol?: string;
  markPrice?: string;
  indexPrice?: string;
  time?: number;
}

const fetchRow = async (): Promise<void> => {
  const [t24, prem] = await Promise.all([
    axios.get<Ticker24h>(`${REST_BASE}/fapi/v1/ticker/24hr`, {
      params: { symbol },
      timeout: 10_000,
      validateStatus: (s) => s === 200,
    }),
    axios.get<Premium>(`${REST_BASE}/fapi/v1/premiumIndex`, {
      params: { symbol },
      timeout: 10_000,
      validateStatus: (s) => s === 200,
    }),
  ]);

  const ltp = Number(t24.data.lastPrice);
  const mark = Number(prem.data.markPrice);
  const lastQty = t24.data.lastQty ?? '';
  const iso = new Date().toISOString();
  const tickerClose =
    typeof t24.data.closeTime === 'number' ? new Date(t24.data.closeTime).toISOString() : '—';

  if (!Number.isFinite(ltp)) {
    console.warn(`${iso} ${symbol} — missing lastPrice in 24hr ticker`);
    return;
  }

  const markStr = Number.isFinite(mark) ? mark.toFixed(4) : '—';
  console.log(
    `[${iso}] USD-M ${symbol}  LTP(last)=${ltp}  lastQty=${lastQty}  mark=${markStr}  tickerClose=${tickerClose}  (fapi REST)`,
  );
}

console.log(
  `Polling ${REST_BASE} every ${pollSec}s for ${symbol} — Ctrl+C to stop\n` +
    'LTP = lastPrice from GET /fapi/v1/ticker/24hr (futures last trade reference).\n',
);

let stopping = false;

const loop = async (): Promise<void> => {
  while (!stopping) {
    try {
      await fetchRow();
    } catch (e) {
      console.error('poll_error', (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

const shutdown = (): void => {
  stopping = true;
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

void loop();
