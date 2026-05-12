/**
 * main.js — Dashboard Bootstrap & WebSocket Client
 * Connects to ws://localhost:4001 and routes all messages to panel modules.
 */

import { ChartManager }     from './chart.js';
import { OrderBookManager, DepthChart } from './orderbook.js';
import { TradeTapeManager } from './trades.js';
import { SignalsPanel }     from './signals.js';
import { SentimentGauge }  from './sentiment.js';

// ─── Module instances ─────────────────────────────────────────────────────
const chart    = new ChartManager('chart-container', 'macd-container');
const obMgr    = new OrderBookManager();
const depthCh  = new DepthChart('depth-canvas');
const tape     = new TradeTapeManager();
const signals  = new SignalsPanel();
const gauge    = new SentimentGauge();

// ─── Price tracker ────────────────────────────────────────────────────────
let lastPrice  = null;

// ─── Format helpers ───────────────────────────────────────────────────────
function fmtPrice(p) {
  if (p == null || !Number.isFinite(p)) return '—';
  if (p >= 10000) return p.toFixed(1);
  if (p >= 1000)  return p.toFixed(2);
  if (p >= 10)    return p.toFixed(3);
  return p.toFixed(4);
}

function flashPrice(el, up) {
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // force reflow
  el.classList.add(up ? 'flash-up' : 'flash-down');
}

// ─── Header update ────────────────────────────────────────────────────────
function updateHeader({ price, mark, bid, ask }) {
  const priceEl = document.getElementById('hdr-price');

  if (price != null && Number.isFinite(price)) {
    priceEl.textContent = fmtPrice(price);
    if (lastPrice !== null && price !== lastPrice) flashPrice(priceEl, price > lastPrice);
    lastPrice = price;
  }
  if (mark != null) {
    const el = document.getElementById('hdr-mark');
    if (el) el.textContent = fmtPrice(mark);
  }
  if (bid != null) {
    const el = document.getElementById('hdr-bid');
    if (el) el.textContent = fmtPrice(bid);
  }
  if (ask != null) {
    const el = document.getElementById('hdr-ask');
    if (el) el.textContent = fmtPrice(ask);
    const spreadEl = document.getElementById('hdr-spread');
    if (spreadEl && bid != null) spreadEl.textContent = (ask - bid).toFixed(4);
  }
}

// ─── WS Status ────────────────────────────────────────────────────────────
function setWsStatus(state, text) {
  const el = document.getElementById('ws-status');
  const txt = document.getElementById('ws-status-text');
  if (el)  el.className = `ws-status ${state}`;
  if (txt) txt.textContent = text;
}

// ─── WebSocket connection ─────────────────────────────────────────────────
const WS_URL = 'ws://localhost:4001';
let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

function connect() {
  setWsStatus('connecting', 'Connecting…');
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    setWsStatus('connected', 'Live');
    reconnectDelay = 1000;
  });

  ws.addEventListener('close', () => {
    setWsStatus('disconnected', 'Reconnecting…');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    setWsStatus('disconnected', 'Error — retrying…');
  });

  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      dispatch(msg);
    } catch (e) {
      console.warn('[ws] parse error:', e);
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
}

// ─── Message Dispatcher ───────────────────────────────────────────────────
function dispatch(msg) {
  switch (msg.type) {
    /* ── Snapshot (initial load) ─ */
    case 'snapshot': {
      // Feed chart
      chart.onSnapshot({ candles: msg.candles, indicators: msg.indicators });

      // Feed order book
      if (msg.depth) {
        obMgr.update(msg.depth);
        depthCh.update(msg.depth.bids, msg.depth.asks);
      }

      // Feed trade tape
      if (msg.trades?.length) tape.loadHistory(msg.trades);

      // Header
      updateHeader({ price: msg.mark, mark: msg.mark, bid: msg.bestBid, ask: msg.bestAsk });

      // Compute initial signals from snapshot data
      if (msg.signals) signals.update(msg.signals);

      // Gauge from initial depth
      if (msg.depth) {
        const ratio = imbalanceRatio(msg.depth.bids, msg.depth.asks);
        gauge.update(ratio);
      }
      break;
    }

    /* ── Kline ─ */
    case 'kline': {
      chart.onKline(msg.tf, msg.candle, msg.isFinal);
      break;
    }

    /* ── Indicators ─ */
    case 'indicators': {
      const { type: _t, ...payload } = msg;
      chart.onIndicators(payload);
      break;
    }

    /* ── Mark Price ─ */
    case 'mark_price': {
      updateHeader({ price: msg.price, mark: msg.price });
      break;
    }

    /* ── 24hr Ticker ─ */
    case 'ticker_24hr': {
      updateHeader({ price: msg.price });
      const changeEl = document.getElementById('hdr-change');
      if (changeEl && msg.priceChange != null) {
        const pct = ((msg.priceChange / (msg.price - msg.priceChange)) * 100).toFixed(2);
        changeEl.textContent = `${msg.priceChange >= 0 ? '+' : ''}${pct}%`;
        changeEl.className = `hdr-change ${msg.priceChange >= 0 ? 'bull' : 'bear'}`;
      }
      break;
    }

    /* ── Book Ticker ─ */
    case 'book_ticker': {
      updateHeader({ bid: msg.bid, ask: msg.ask });
      break;
    }

    /* ── Depth ─ */
    case 'depth': {
      obMgr.update({ bids: msg.bids, asks: msg.asks });
      depthCh.update(msg.bids, msg.asks);
      // Update sentiment from depth imbalance
      const ratio = imbalanceRatio(msg.bids, msg.asks);
      gauge.update(ratio);
      // Update VWAP
      break;
    }

    /* ── Agg Trade ─ */
    case 'agg_trade': {
      tape.addTrade(msg);
      break;
    }

    /* ── Strategy Signals ─ */
    case 'signals': {
      signals.update(msg);
      // Update chart header with ref price
      if (msg.refPrice) updateHeader({ price: msg.refPrice });
      break;
    }

    /* ── Connection status ─ */
    case 'status': {
      if (msg.connected === true)  setWsStatus('connected', 'Live');
      if (msg.connected === false) setWsStatus('disconnected', 'Disconnected');
      if (msg.reconnecting) setWsStatus('connecting', `Reconnecting #${msg.attempt}…`);
      break;
    }

    /* ── Heartbeat ─ */
    case 'heartbeat': {
      console.debug(`[hb] ${new Date(msg.ts).toISOString()} — clients: ${msg.clients}`);
      break;
    }
  }
}

// ─── Imbalance helper ─────────────────────────────────────────────────────
function imbalanceRatio(bids = [], asks = []) {
  const bidVol = bids.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
  const askVol = asks.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
  const total = bidVol + askVol;
  return total > 0 ? bidVol / total : 0.5;
}

// ─── Init ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  chart.init();
  connect();
});
