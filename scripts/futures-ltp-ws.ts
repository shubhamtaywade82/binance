/**
 * Binance **@aggTrade** last price over WebSocket (no REST).
 *
 * **Two different products / hosts** (do not mix the docs):
 * - **Spot** (Binance “General WSS” you quoted): `wss://stream.binance.com:9443` or `:443`
 * - **USD-M futures**: `wss://fstream.binance.com/market` for @aggTrade
 *
 * Defaults target **USD-M perpetuals** (`fstream` routed through `/market`).
 *
 * Usage:
 *   npm run futures:ltp
 *   npm run futures:ltp -- ETHUSDT
 *
 * Env:
 *   BINANCE_WS_BASE   — default root `wss://fstream.binance.com`
 *   FUTURES_LTP_WS_PATH — `raw` (default `/market/ws/<stream>`), `combined` (`/market/stream?streams=`), or `subscribe` (connect `/market/ws` then JSON SUBSCRIBE)
 *
 * Implements Binance guidance: reply to **ping** with **pong** (same payload), reconnect on **serverShutdown**.
 *
 * Fallback when WSS has no data: `npm run futures:ltp:rest`
 */
import WebSocket from 'ws';

const WS_BASE = (process.env.BINANCE_WS_BASE ?? 'wss://fstream.binance.com')
  .replace(/\/$/, '')
  .replace(/\/(market|public|private)(\/(ws|stream))?$/, '');
const pathRaw = (process.env.FUTURES_LTP_WS_PATH ?? 'raw').toLowerCase();
const pathMode = pathRaw === 'combined' || pathRaw === 'subscribe' ? pathRaw : 'raw';
const symbolArg = process.argv[2] ?? 'SOLUSDT';
const streamSymbol = symbolArg.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
const streamName = `${streamSymbol}@aggTrade`;

if (!streamSymbol) {
  console.error('Usage: npm run futures:ltp -- [SYMBOL]');
  process.exit(1);
}

interface AggTradePayload {
  e?: string;
  E?: number;
  s?: string;
  p?: string;
  q?: string;
}

function unwrapPayload(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg.stream && msg.data && typeof msg.data === 'object') {
    return msg.data as Record<string, unknown>;
  }
  return msg;
}

function parseIncoming(raw: WebSocket.RawData): { kind: 'aggTrade'; row: AggTradePayload } | { kind: 'serverShutdown' } | { kind: 'control' } | { kind: 'skip' } {
  try {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (typeof msg.result !== 'undefined' && 'id' in msg) {
      return { kind: 'control' };
    }
    if (typeof msg.code === 'number' && typeof msg.msg === 'string') {
      console.warn('ws_control_error', msg);
      return { kind: 'control' };
    }
    const d = unwrapPayload(msg);
    if (!d) return { kind: 'skip' };
    if (d.e === 'serverShutdown') return { kind: 'serverShutdown' };
    if (d.e === 'aggTrade') return { kind: 'aggTrade', row: d as AggTradePayload };
    return { kind: 'skip' };
  } catch {
    return { kind: 'skip' };
  }
}

function buildUrl(): string {
  if (pathMode === 'subscribe') {
    return `${WS_BASE}/market/ws`;
  }
  if (pathMode === 'combined') {
    return `${WS_BASE}/market/stream?streams=${streamName}`;
  }
  return `${WS_BASE}/market/ws/${streamName}`;
}

const productHint =
  WS_BASE.includes('fstream') || WS_BASE.includes('binancefuture.com')
    ? 'USD-M perpetual futures host'
    : 'custom WS_BASE (expected USD-M futures root)';

let stopping = false;
let attempt = 0;
let socket: WebSocket | null = null;
let noDataTimer: ReturnType<typeof setTimeout> | null = null;

function clearNoDataTimer(): void {
  if (noDataTimer) {
    clearTimeout(noDataTimer);
    noDataTimer = null;
  }
}

function scheduleNoDataHint(url: string): void {
  clearNoDataTimer();
  noDataTimer = setTimeout(() => {
    console.warn(
        `\nStill no aggTrade after 15s (open OK). ${productHint}\n` +
        `  URL: ${url}\n` +
        `  Try: FUTURES_LTP_WS_PATH=combined  or  FUTURES_LTP_WS_PATH=subscribe\n` +
        `  REST fallback: npm run futures:ltp:rest\n`,
    );
  }, 15_000);
}

function connect(): void {
  if (stopping) return;
  const url = buildUrl();
  if (attempt === 0) {
    console.log(`${productHint}\n${pathMode} → ${url}\nCtrl+C to stop.\n`);
  } else {
    console.log(`Reconnecting (attempt ${attempt}) ${url} …`);
  }

  const ws = new WebSocket(url);
  socket = ws;

  ws.on('open', () => {
    attempt = 0;
    console.log(`[${new Date().toISOString()}] WebSocket open  (${pathMode}, @aggTrade → LTP)`);
    if (pathMode === 'subscribe') {
      ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [streamName], id: Date.now() }));
    }
    scheduleNoDataHint(url);
  });

  // Binance: respond to WebSocket PING with PONG (same payload) within ~1 minute.
  ws.on('ping', (data) => {
    ws.pong(data, true);
  });

  ws.on('message', (raw) => {
    const parsed = parseIncoming(raw);
    if (parsed.kind === 'control' || parsed.kind === 'skip') return;
    if (parsed.kind === 'serverShutdown') {
      console.warn(`[${new Date().toISOString()}] serverShutdown — reconnecting soon`);
      clearNoDataTimer();
      ws.close();
      return;
    }
    clearNoDataTimer();
    const d = parsed.row;
    const price = Number(d.p);
    const qty = Number(d.q);
    const sym = String(d.s ?? symbolArg.toUpperCase());
    const eventTime = typeof d.E === 'number' ? d.E : Date.now();
    if (!Number.isFinite(price)) return;
    const iso = new Date(eventTime).toISOString();
    const hostTag = WS_BASE.includes('fstream') ? 'wss fstream/market' : 'custom ws/market';
    console.log(`[${iso}] LTP ${sym} = ${price}  qty=${Number.isFinite(qty) ? qty : 0}  (${hostTag})`);
  });

  ws.on('error', (err) => {
    console.error('ws_error', err.message);
  });

  ws.on('close', () => {
    clearNoDataTimer();
    socket = null;
    if (stopping) return;
    attempt += 1;
    const delayMs = Math.min(60_000, 500 * 2 ** Math.min(attempt, 10));
    console.warn(`WebSocket closed; retry in ${delayMs}ms`);
    setTimeout(connect, delayMs);
  });
}

function shutdown(): void {
  stopping = true;
  clearNoDataTimer();
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

connect();
