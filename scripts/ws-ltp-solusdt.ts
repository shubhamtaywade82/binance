/**
 * Connects to Binance USD-M perpetual WebSocket and logs last traded price (LTP)
 * from the aggregate trade stream (@aggTrade). No API keys required.
 *
 * Usage:
 *   npm run ws:ltp
 *   npm run ws:ltp -- ETHUSDT
 *
 * Env:
 *   BINANCE_WS_BASE=wss://fstream.binance.com  (default root for USD-M)
 *   USE_SPOT=1  — use spot stream host (good check if fstream receives no frames)
 */
import WebSocket from 'ws';

const useSpot = process.env.USE_SPOT === '1' || process.env.USE_SPOT === 'true';
const WS_BASE = (
  useSpot
    ? 'wss://stream.binance.com:9443'
    : (process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com')
)
  .replace(/\/$/, '')
  .replace(/\/(market|public|private)(\/(ws|stream))?$/, '');
const symbolArg = process.argv[2] ?? 'SOLUSDT';
const streamSymbol = symbolArg.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

if (!streamSymbol) {
  console.error('Usage: npm run ws:ltp -- [SYMBOL]   e.g. SOLUSDT');
  process.exit(1);
}

const url = useSpot
  ? `${WS_BASE}/ws/${streamSymbol}@aggTrade`
  : `${WS_BASE}/market/ws/${streamSymbol}@aggTrade`;

interface AggTradePayload {
  e?: string;
  E?: number;
  s?: string;
  p?: string;
  q?: string;
}

const unwrapPayload = (msg: Record<string, unknown>): AggTradePayload | null => {
  if (msg.stream && msg.data && typeof msg.data === 'object') {
    return msg.data as AggTradePayload;
  }
  return msg as AggTradePayload;
}

const parseAggTrade = (raw: WebSocket.RawData): { price: number; qty: number; symbol: string; eventTime: number } | null => {
  try {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    const d = unwrapPayload(msg);
    if (!d || d.e !== 'aggTrade') return null;
    const price = Number(d.p);
    const qty = Number(d.q);
    const symbol = String(d.s ?? symbolArg.toUpperCase());
    const eventTime = typeof d.E === 'number' ? d.E : Date.now();
    if (!Number.isFinite(price)) return null;
    return { price, qty: Number.isFinite(qty) ? qty : 0, symbol, eventTime };
  } catch {
    return null;
  }
}

console.log(`Connecting ${url} … (${useSpot ? 'spot' : 'USD-M'})`);

const ws = new WebSocket(url);
let sawMessage = false;

ws.on('open', () => {
  console.log('WebSocket open — streaming LTP (aggTrade). Ctrl+C to exit.\n');
  setTimeout(() => {
    if (!sawMessage && ws.readyState === WebSocket.OPEN) {
      console.warn(
        'No trades received yet (12s). If this stays silent, try npm run futures:ltp:rest to verify REST mark/ticker access.\n',
      );
    }
  }, 12_000);
});

ws.on('message', (raw) => {
  const row = parseAggTrade(raw);
  if (!row) return;
  sawMessage = true;
  const iso = new Date(row.eventTime).toISOString();
  console.log(`[${iso}] LTP ${row.symbol} = ${row.price}  (qty ${row.qty})`);
});

ws.on('ping', (payload) => {
  ws.pong(payload, true);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
});

ws.on('close', (code, reason) => {
  console.log(`WebSocket closed code=${code} reason=${reason.toString()}`);
});

const shutdown = (): void => {
  ws.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
