/**
 * Dashboard bootstrap & WebSocket client.
 * WS URL: `VITE_DASHBOARD_WS_URL` if set.
 * LTP: the bot sends `ltpDecimalPlaces` = Binance tick fractional digits (display). The chart uses one extra
 * decimal internally for smooth LTP stepping; axis / order book / tape use display only. Top bar (LTP, mark,
 * bid, ask, spread) uses movement precision via `fmtLtpMovement` / `fmtSpreadMovement` (`ui/ltp-precision.js`).
 * Dev (Vite): same host + path `/__dashboard_ws` (proxied to the bot on 127.0.0.1:4001 — see vite.config.js).
 * Production build: `ws(s)://` page host + `VITE_DASHBOARD_WS_PORT` (default 4001).
 * The WebSocket is served by the bot when `DASHBOARD_ENABLED=true`.
 */

import { escapeHtml, renderAiBriefMarkdown } from './ai-brief-render.js';
import { ChartManager } from './chart.js';
import { fmtLtpMovement, fmtSpreadMovement, getMinTickDecimalPlaces } from './ltp-precision.js';
import { OrderBookManager } from './orderbook.js';
import { TradeTapeManager } from './trades.js';
import { SignalsPanel }     from './signals.js';
import { SentimentGauge }  from './market-sentiment.js';
import { MicrostructurePanel } from './microstructure.js';
import { Rolling1mTradeStats } from './rolling-1m-stats.js';
import { ScriptManager } from './scripts/ui/script-manager.js';
import { ScriptEditor } from './scripts/ui/script-editor.js';

// ─── Module instances ─────────────────────────────────────────────────────
const chart    = new ChartManager('chart-container');
const obMgr    = new OrderBookManager();
const tape     = new TradeTapeManager();
const signals  = new SignalsPanel();
const gauge    = new SentimentGauge();
const msPanel  = new MicrostructurePanel();
const rolling1m = new Rolling1mTradeStats();
/** User-script runtime (NanoPine). Mounted after chart.init() so the worker has chart data to read. */
let scripts = null;
let scriptEditor = null;

const STORAGE_KEY_SYMBOL = 'nanopine_active_symbol';

const topOfBookFromDepth = (depth) => {
  const b = depth?.bids?.[0]?.price;
  const a = depth?.asks?.[0]?.price;
  if (Number.isFinite(b) && Number.isFinite(a) && b <= a) return { bid: b, ask: a };
  return null;
}

/** Multiplex watch symbol for this browser (matches server `getSym`). */
let activeWatchSymbol = null;

const shortWatchLabel = (sym) => {
  if (!sym || typeof sym !== 'string') return '';
  return sym.toUpperCase().replace(/USDT$/i, '').replace(/BUSD$/i, '');
}

let currentWatchlist = [];
let allAvailableSymbols = [];
let dropdownOpen = false;

const initWatchlistBar = (msg) => {
  const { watchlist, allSymbols } = msg;
  if (Array.isArray(watchlist)) {
    currentWatchlist = watchlist.map(s => String(s).toUpperCase());
  }
  if (Array.isArray(allSymbols)) {
    allAvailableSymbols = allSymbols.map(s => String(s).toUpperCase()).sort();
  }

  const bar = document.getElementById('watchlist-bar');
  if (bar) {
    if (currentWatchlist.length <= 1) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
    } else {
      bar.classList.remove('hidden');
      bar.innerHTML = '';
      for (const s of currentWatchlist) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'watch-chip' + (s === activeWatchSymbol ? ' active' : '');
        b.dataset.symbol = s;
        b.textContent = shortWatchLabel(s);
        b.setAttribute('aria-pressed', s === activeWatchSymbol ? 'true' : 'false');
        b.addEventListener('click', () => selectWatchSymbol(s));
        bar.appendChild(b);
      }
    }
  }

  if (dropdownOpen) {
    const input = document.getElementById('symbol-search-input');
    renderSymbolDropdownList(input ? input.value : '');
  }
};

const renderSymbolDropdownList = (query = '') => {
  const list = document.getElementById('symbol-list');
  if (!list) return;
  list.innerHTML = '';
  const q = query.trim().toUpperCase();

  let displayed = [];
  let isSearch = q.length > 0;

  if (isSearch) {
    // Search across all available symbols
    displayed = allAvailableSymbols.filter(s => s.includes(q)).slice(0, 50);
  } else {
    // Just show current watchlist
    displayed = currentWatchlist;
  }

  if (displayed.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'symbol-item';
    empty.style.color = 'var(--text-dim)';
    empty.textContent = isSearch ? 'No matching symbols' : 'Watchlist empty';
    list.appendChild(empty);
    return;
  }

  if (!isSearch && currentWatchlist.length > 0) {
    const head = document.createElement('div');
    head.className = 'symbol-list-header';
    head.textContent = 'Watchlist';
    list.appendChild(head);
  } else if (isSearch) {
    const head = document.createElement('div');
    head.className = 'symbol-list-header';
    head.textContent = `Search Results (${q})`;
    list.appendChild(head);
  }

  for (const s of displayed) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'symbol-item' + (s === activeWatchSymbol ? ' active' : '');
    b.dataset.symbol = s;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', s === activeWatchSymbol ? 'true' : 'false');

    const nameWrap = document.createElement('span');
    nameWrap.className = 'symbol-item-name';
    nameWrap.textContent = shortWatchLabel(s);

    const tag = document.createElement('span');
    tag.className = 'symbol-item-tag';
    tag.textContent = s.endsWith('USDT') ? 'USDT' : 'PERP';

    b.appendChild(nameWrap);
    b.appendChild(tag);

    b.addEventListener('click', () => {
      selectWatchSymbol(s);
      closeSymbolDropdown();
    });

    list.appendChild(b);
  }
};

const toggleSymbolDropdown = (e) => {
  if (e) e.stopPropagation();
  const dd = document.getElementById('symbol-dropdown');
  const badge = document.getElementById('pair-badge');
  if (!dd || !badge) return;

  dropdownOpen = !dropdownOpen;
  if (dropdownOpen) {
    dd.hidden = false;
    badge.setAttribute('aria-expanded', 'true');
    renderSymbolDropdownList('');
    const input = document.getElementById('symbol-search-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  } else {
    closeSymbolDropdown();
  }
};

const closeSymbolDropdown = () => {
  const dd = document.getElementById('symbol-dropdown');
  const badge = document.getElementById('pair-badge');
  if (!dd || !badge) return;
  dropdownOpen = false;
  dd.hidden = true;
  badge.setAttribute('aria-expanded', 'false');
};

const initSymbolDropdown = () => {
  const badge = document.getElementById('pair-badge');
  const input = document.getElementById('symbol-search-input');
  const dd = document.getElementById('symbol-dropdown');
  if (!badge || !input || !dd) return;

  badge.addEventListener('click', toggleSymbolDropdown);

  input.addEventListener('input', (e) => {
    renderSymbolDropdownList(e.target.value);
  });

  input.addEventListener('keydown', (e) => {
    const items = Array.from(dd.querySelectorAll('.symbol-item[role="option"]'));
    if (!items.length) return;
    const activeIdx = items.findIndex(item => item === document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = activeIdx + 1 < items.length ? activeIdx + 1 : 0;
      items[nextIdx].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = activeIdx - 1 >= 0 ? activeIdx - 1 : items.length - 1;
      items[prevIdx].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSymbolDropdown();
    }
  });

  dd.addEventListener('keydown', (e) => {
    const items = Array.from(dd.querySelectorAll('.symbol-item[role="option"]'));
    if (!items.length) return;
    const activeIdx = items.findIndex(item => item === document.activeElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const nextIdx = activeIdx + 1 < items.length ? activeIdx + 1 : 0;
      items[nextIdx].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prevIdx = activeIdx - 1 >= 0 ? activeIdx - 1 : items.length - 1;
      items[prevIdx].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSymbolDropdown();
      badge.focus();
    }
  });

  document.addEventListener('click', (e) => {
    if (dropdownOpen && !dd.contains(e.target) && !badge.contains(e.target)) {
      closeSymbolDropdown();
    }
  });
};

const selectWatchSymbol = (sym) => {
  if (!sym || sym === activeWatchSymbol) return;
  localStorage.setItem(STORAGE_KEY_SYMBOL, sym);
  syncUiWithSymbol(sym);
  updateUrlWithSymbol(sym);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_watch_symbol', symbol: sym }));
  }
}

const msgSymbolUpper = (msg) => {
  if (msg.symbol == null || msg.symbol === '') return null;
  return String(msg.symbol).toUpperCase();
}

const appliesToActiveWatch = (msg) => {
  const m = msgSymbolUpper(msg);
  if (m == null) return true;
  return m === activeWatchSymbol;
}

const syncUiWithSymbol = (sym) => {
  if (!sym) return;
  const s = sym.toUpperCase();
  const hdrSym = document.getElementById('hdr-symbol');
  if (hdrSym) hdrSym.textContent = s;

  const mtfHdr = Array.from(document.querySelectorAll('.sig-section-header'))
    .find(el => el.textContent.includes('MTF Stack'));
  if (mtfHdr) {
    mtfHdr.textContent = `MTF Stack (${s.replace(/USDT$/, '')})`;
  }
}

const updateUrlWithSymbol = (sym) => {
  if (!sym) return;
  const url = new URL(window.location);
  if (url.searchParams.get('symbol') === sym.toUpperCase()) return;
  url.searchParams.set('symbol', sym.toUpperCase());
  window.history.replaceState({}, '', url);
}

let lastPrice = null;
/** Last chart LTP (target close) — flash on kline compares to this; header digits follow smoothed line via chart listener. */
let lastLtpTarget = null;
let lastOpenPositions = [];

// ─── Format helpers ───────────────────────────────────────────────────────
const flashPrice = (el, up) => {
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // force reflow
  el.classList.add(up ? 'flash-up' : 'flash-down');
}

// ─── Header update ────────────────────────────────────────────────────────
const updateHeader = ({ price, mark, bid, ask }) => {
  const priceEl = document.getElementById('hdr-price');

  if (price != null && Number.isFinite(price)) {
    priceEl.textContent = fmtLtpMovement(price);
    if (lastPrice !== null && price !== lastPrice) flashPrice(priceEl, price > lastPrice);
    lastPrice = price;
  }
  if (mark != null) {
    const el = document.getElementById('hdr-mark');
    if (el) el.textContent = fmtLtpMovement(mark);
  }
  if (bid != null) {
    const el = document.getElementById('hdr-bid');
    if (el) el.textContent = fmtLtpMovement(bid);
  }
  if (ask != null) {
    const el = document.getElementById('hdr-ask');
    if (el) el.textContent = fmtLtpMovement(ask);
    const spreadEl = document.getElementById('hdr-spread');
    if (spreadEl && bid != null && Number.isFinite(bid)) {
      spreadEl.textContent = fmtSpreadMovement(ask - bid);
    }
  }
}

// ─── WS Status ────────────────────────────────────────────────────────────
const setWsStatus = (state, text) => {
  const el = document.getElementById('ws-status');
  const txt = document.getElementById('ws-status-text');
  if (el)  el.className = `ws-status ${state}`;
  if (txt) txt.textContent = text;
}

const dashboardWebSocketUrl = () => {
  const fromEnv = import.meta.env?.VITE_DASHBOARD_WS_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();

  const { protocol, host } = window.location;
  const wsScheme = protocol === 'https:' ? 'wss:' : 'ws:';
  
  // Use URL search param or localStorage to decide initial symbol for handshake
  const urlParams = new URLSearchParams(window.location.search);
  const initialSym = urlParams.get('symbol') || localStorage.getItem(STORAGE_KEY_SYMBOL);
  const query = initialSym ? `?symbol=${initialSym}` : '';

  if (import.meta.env.DEV) {
    return `${wsScheme}//${host}/__dashboard_ws${query}`;
  }

  const port = import.meta.env?.VITE_DASHBOARD_WS_PORT ?? '4001';
  const hostname = window.location.hostname || 'localhost';
  return `${wsScheme}//${hostname}:${port}${query}`;
}

// ─── WebSocket connection ─────────────────────────────────────────────────
let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

const connect = () => {
  const connectUrl = dashboardWebSocketUrl();
  setWsStatus('connecting', `Connecting… (${connectUrl})`);
  ws = new WebSocket(connectUrl);

  ws.addEventListener('open', () => {
    setWsStatus('connected', 'Live');
    reconnectDelay = 1000;

    const stored = localStorage.getItem(STORAGE_KEY_SYMBOL);
    if (stored && stored !== activeWatchSymbol) {
      ws.send(JSON.stringify({ type: 'set_watch_symbol', symbol: stored }));
    }
  });

  ws.addEventListener('close', () => {
    setWsStatus('disconnected', 'Reconnecting…');
    scheduleReconnect();
  });

  ws.addEventListener('error', () => {
    setWsStatus('disconnected', 'WS error — is the bot running with DASHBOARD_ENABLED=true?');
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

const scheduleReconnect = () => {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
}

const syncVwap1mRow = () => {
  const fromTrades = rolling1m.snapshot();
  if (fromTrades.vwap != null && fromTrades.volume != null && fromTrades.volume > 0) {
    gauge.updateVwap(fromTrades.vwap, fromTrades.volume);
    return;
  }
  const fromBar = chart.getLast1mCandleTypicalAndVolume();
  if (fromBar.vwap != null && fromBar.volume != null) {
    gauge.updateVwap(fromBar.vwap, fromBar.volume);
    return;
  }
  gauge.updateVwap(null, null);
}

const refreshOpenPositionOverlay = () => {
  chart.setOpenPositions(lastOpenPositions, activeWatchSymbol);
}

// ─── Message Dispatcher ───────────────────────────────────────────────────
const dispatch = (msg) => {
  switch (msg.type) {
    /* ── Snapshot (initial load) ─ */
    case 'snapshot': {
      activeWatchSymbol = msg.symbol ? String(msg.symbol).toUpperCase() : activeWatchSymbol;
      if (activeWatchSymbol) {
        localStorage.setItem(STORAGE_KEY_SYMBOL, activeWatchSymbol);
        syncUiWithSymbol(activeWatchSymbol);
        updateUrlWithSymbol(activeWatchSymbol);
      }
      initWatchlistBar(msg);

      chart.applyDashboardLtpPrecision(msg);

      if (msg.config) {
        const c = msg.config;
        const levEl = document.getElementById('conf-leverage');
        const capEl = document.getElementById('conf-capital');
        const envEl = document.getElementById('sys-env-tag');
        const killEl = document.getElementById('toggle-kill-switch');
        if (levEl) levEl.value = `${c.leverage}x`;
        if (capEl) capEl.value = `${c.capitalPerTrade} USDT`;
        if (envEl) envEl.textContent = c.envTag;
        if (killEl instanceof HTMLInputElement) {
          killEl.checked = c.killSwitch;
          killEl.addEventListener('change', () => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'set_kill_switch', active: killEl.checked }));
            }
          }, { once: true }); // Avoid double listeners on snapshot resync
        }
      }

      // Feed chart
      chart.onSnapshot({
        candles: msg.candles,
        indicators: msg.indicators,
        availableTimeframes: msg.availableTimeframes,
      });
      scripts?.onSnapshot();
      lastOpenPositions = Array.isArray(msg.positions) ? msg.positions : [];
      refreshOpenPositionOverlay();

      // Feed order book
      if (msg.depth) {
        const dp = getMinTickDecimalPlaces();
        obMgr.resetForSymbol(1 / (10 ** dp));
        obMgr.update(msg.depth);
      }

      // Feed trade tape + rolling VWAP window
      rolling1m.reset();
      if (msg.trades?.length) {
        tape.loadHistory(msg.trades);
        for (const t of msg.trades) {
          rolling1m.ingest(t.price, t.qty, t.ts);
        }
      }

      // Header — LTP must match chart series (not mark); USD-M had no @ticker before, so LTP could stick on mark.
      const tf = chart.getCurrentTf();
      const fromChart = chart.getLastCloseForTf(tf);
      const series = msg.candles?.[tf];
      const lastSnap =
        Array.isArray(series) && series.length ? Number(series[series.length - 1].close) : null;
      const ltp =
        fromChart ??
        (Number.isFinite(lastSnap) ? lastSnap : null) ??
        (Number.isFinite(msg.mark) ? msg.mark : null);
      updateHeader({
        mark: Number.isFinite(msg.mark) ? msg.mark : null,
        bid: msg.bestBid,
        ask: msg.bestAsk,
      });
      if (Number.isFinite(msg.mark)) obMgr.setMarkPrice(msg.mark);
      lastLtpTarget = Number.isFinite(ltp) ? ltp : null;
      if (Number.isFinite(ltp)) {
        lastPrice = ltp;
        if (chart.getLastCloseForTf(chart.getCurrentTf()) == null) {
          const priceEl = document.getElementById('hdr-price');
          if (priceEl) priceEl.textContent = fmtLtpMovement(ltp);
        }
      }

      // Compute initial signals from snapshot data
      if (msg.signals) {
        signals.update(msg.signals);
        chart.applySignalOverlays(msg.signals);
      }

      // Microstructure initial state + gauge
      if (msg.microstructure) {
        msPanel.update(msg.microstructure);
        gauge.update(msPanel.getObiRatio());
      } else if (msg.depth) {
        const ratio = imbalanceRatio(msg.depth.bids, msg.depth.asks);
        gauge.update(ratio);
      }

      const bookTop = msg.depth ? topOfBookFromDepth(msg.depth) : null;
      if (bookTop) chart.setBookTopLevels(bookTop.bid, bookTop.ask);
      else if (Number.isFinite(msg.bestBid) && Number.isFinite(msg.bestAsk)) {
        chart.setBookTopLevels(msg.bestBid, msg.bestAsk);
      }
      refreshOpenPositionOverlay();

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_chart_tf', tf: chart.getCurrentTf() }));
      }
      syncVwap1mRow();
      break;
    }

    /* ── Kline ─ */
    case 'kline': {
      if (!appliesToActiveWatch(msg)) break;
      chart.onKline(msg.tf, msg.candle, msg.isFinal);
      if (msg.isFinal === true) scripts?.onClosedBar(msg.tf, msg.candle);
      if (msg.tf === '1m') syncVwap1mRow();
      if (lastOpenPositions.length) refreshOpenPositionOverlay();
      if (msg.tf === chart.getCurrentTf()) {
        const target = chart.getLastCloseForTf(chart.getCurrentTf());
        if (target != null && Number.isFinite(target)) {
          const priceEl = document.getElementById('hdr-price');
          if (lastLtpTarget != null && target !== lastLtpTarget) {
            flashPrice(priceEl, target > lastLtpTarget);
          }
          lastLtpTarget = target;
        }
      }
      break;
    }

    /* ── Indicators ─ */
    case 'indicators': {
      const { type: _t, ...payload } = msg;
      chart.onIndicators(payload);
      break;
    }

    case 'history_chunk': {
      if (msg.symbol && String(msg.symbol).toUpperCase() !== activeWatchSymbol) break;
      chart.onHistoryChunk(msg.tf, msg.candles);
      break;
    }

    case 'history_end': {
      if (msg.symbol && String(msg.symbol).toUpperCase() !== activeWatchSymbol) break;
      chart.onHistoryEnd(msg.tf);
      break;
    }

    case 'history_error': {
      chart.onHistoryError(msg.tf);
      break;
    }

    case 'history_busy': {
      chart.onHistoryBusy(msg.tf);
      break;
    }

    /* ── Mark Price (futures mark ≠ last; do not put mark on the main LTP slot) ─ */
    case 'mark_price': {
      if (!appliesToActiveWatch(msg)) break;
      updateHeader({ mark: msg.price });
      if (Number.isFinite(msg.price)) obMgr.setMarkPrice(msg.price);
      chart.setMarkPrice(msg.price);
      if (lastOpenPositions.length) refreshOpenPositionOverlay();
      break;
    }

    case 'paper_position_update':
    case 'position_update': {
      lastOpenPositions = Array.isArray(msg.positions) ? msg.positions : [];
      refreshOpenPositionOverlay();
      break;
    }

    /* ── Event-bus position lifecycle handled below in the rich block. ─ */
    case 'trail_update': {
      const orderId = String(msg.orderId || '');
      const pos = lastOpenPositions.find((p) => p.orderId === orderId);
      if (pos) {
        pos.currentTrail = msg.currentTrail;
        pos.highWater = msg.highWater;
        pos.lowWater = msg.lowWater;
        refreshOpenPositionOverlay();
      }
      break;
    }
    case 'strategy_signal': {
      pushAlertRow({
        kind: msg.signal === 'LONG' ? 'long' : (msg.signal === 'SHORT' ? 'short' : 'flat'),
        icon: msg.signal === 'LONG' ? '🟢' : msg.signal === 'SHORT' ? '🔴' : '⚪',
        title: `${msg.symbol || '?'} ${msg.signal}`,
        detail: `${msg.regime || msg.strategyId || ''} conf ${(((msg.confidence || 0) * 100).toFixed(0))}%`,
      });
      break;
    }
    case 'order_rejected': {
      const reason = String(msg.reason || msg.payload?.reason || 'UNKNOWN');
      pushAlertRow({
        kind: 'reject',
        icon: '⚠️',
        title: `Rejected ${msg.symbol || msg.requested?.symbol || ''}`,
        detail: reason,
      });
      showToast(`Order rejected · ${reason}`, 'warn');
      break;
    }
    case 'position_opened': {
      const oid = String(msg.orderId || '');
      if (oid) {
        const existing = lastOpenPositions.find((p) => p.orderId === oid);
        const merged = {
          orderId: oid, symbol: msg.symbol, side: msg.side,
          entryPrice: msg.price, quantity: msg.quantity,
          stopLoss: msg.stopLoss, takeProfit: msg.takeProfit,
          openedAt: msg.timestamp || Date.now(), leverage: msg.leverage,
          unrealizedUsdt: 0,
        };
        if (existing) Object.assign(existing, merged);
        else lastOpenPositions.push(merged);
        refreshOpenPositionOverlay();
      }
      pushAlertRow({
        kind: msg.side === 'LONG' ? 'long' : 'short',
        icon: msg.side === 'LONG' ? '🟢' : '🔴',
        title: `Filled ${msg.symbol || '?'} ${msg.side || ''}`,
        detail: `@ ${Number(msg.price ?? 0).toFixed(4)} qty ${Number(msg.quantity ?? 0).toFixed(4)}`,
      });
      showToast(`${msg.symbol} ${msg.side} filled`, 'info');
      break;
    }
    case 'position_closed': {
      const oid = String(msg.orderId || '');
      lastOpenPositions = lastOpenPositions.filter((p) => p.orderId !== oid);
      refreshOpenPositionOverlay();
      const net = Number(msg.netUsdt ?? 0);
      pushAlertRow({
        kind: net >= 0 ? 'win' : 'loss',
        icon: net >= 0 ? '💰' : '📉',
        title: `Closed ${msg.symbol || '?'} · ${msg.reason || ''}`,
        detail: `Net ${net.toFixed(2)} USDT`,
      });
      showToast(`${msg.symbol} closed · ${(net >= 0 ? '+' : '')}${net.toFixed(2)}`, net >= 0 ? 'success' : 'warn');
      break;
    }

    /* ── Forced Liquidation Orders ─ */
    case 'force_order': {
      if (!appliesToActiveWatch(msg)) break;
      chart.addLiquidationMarker(msg);
      break;
    }

    /* ── OI Regime ─ */
    case 'oi_regime': {
      if (!appliesToActiveWatch(msg)) break;
      chart.setOiRegime(msg);
      break;
    }

    /* ── Funding Rate ─ */
    case 'funding': {
      if (!appliesToActiveWatch(msg)) break;
      chart.setFundingRate(msg);
      break;
    }

    /* ── 24hr Ticker: 24h stats only — main LTP stays chart/kline (avoids fighting aggTrade). ─ */
    case 'ticker_24hr': {
      if (!appliesToActiveWatch(msg)) break;
      const changeEl = document.getElementById('hdr-change');
      if (changeEl) {
        let pctStr = null;
        let bull = true;
        if (msg.priceChangePercent != null && Number.isFinite(msg.priceChangePercent)) {
          const v = Number(msg.priceChangePercent);
          bull = v >= 0;
          pctStr = `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
        } else if (
          msg.priceChange != null &&
          Number.isFinite(msg.priceChange) &&
          Number.isFinite(msg.price)
        ) {
          const open = msg.price - msg.priceChange;
          bull = msg.priceChange >= 0;
          const pct = open !== 0 ? (msg.priceChange / open) * 100 : 0;
          pctStr = `${msg.priceChange >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        }
        if (pctStr != null) {
          changeEl.textContent = pctStr;
          changeEl.className = `hdr-change ${bull ? 'bull' : 'bear'}`;
        }
      }
      chart.set24hHighLow(msg.highPrice, msg.lowPrice);
      break;
    }

    /* ── Book Ticker ─ */
    case 'book_ticker': {
      if (!appliesToActiveWatch(msg)) break;
      updateHeader({ bid: msg.bid, ask: msg.ask });
      chart.setBookTopLevels(msg.bid, msg.ask);
      if (lastOpenPositions.length) refreshOpenPositionOverlay();
      break;
    }

    /* ── Depth ─ */
    case 'depth': {
      if (!appliesToActiveWatch(msg)) break;
      obMgr.update({ bids: msg.bids, asks: msg.asks });
      const top = topOfBookFromDepth({ bids: msg.bids, asks: msg.asks });
      if (top) chart.setBookTopLevels(top.bid, top.ask);
      break;
    }

    /* ── Microstructure ─ */
    case 'microstructure': {
      if (!appliesToActiveWatch(msg)) break;
      msPanel.update(msg);
      gauge.update(msPanel.getObiRatio());
      chart.setCurrentSpread(msg.spreadBps);
      chart.setTfiSnapshot(msg.tfi5s);
      chart.setDepthPressure(msg.depthPressure10);
      chart.setObi(msg.weightedObi5?.weightedObi);
      chart.setMicroBars(msg.microBars5s);
      break;
    }

    /* ── Agg Trade (tape only; header LTP follows chart close via kline) ─ */
    case 'agg_trade': {
      if (!appliesToActiveWatch(msg)) break;
      tape.addTrade(msg);
      rolling1m.ingest(msg.price, msg.qty, msg.ts);
      syncVwap1mRow();
      break;
    }

    /* ── Strategy Signals ─ */
    case 'signals': {
      const { type: _sigType, ...sigRest } = msg;
      signals.update(sigRest);
      chart.applySignalOverlays(sigRest);
      break;
    }

    case 'ai_brief': {
      const body = document.getElementById('ai-brief-body');
      const st = document.getElementById('ai-brief-status');
      const isPartial = msg.partial === true;
      if (st) {
        if (msg.error) {
          st.textContent = msg.ts ? new Date(msg.ts).toLocaleTimeString() : '—';
          st.className = 'mono-sm bear';
        } else if (isPartial) {
          st.textContent = 'Streaming…';
          st.className = 'mono-sm dim';
        } else {
          st.textContent = msg.ts ? new Date(msg.ts).toLocaleTimeString() : '—';
          st.className = 'mono-sm dim';
        }
      }
      if (!body) break;
      body.classList.add('ai-brief-prose');
      if (msg.error) {
        body.innerHTML = `<p class="ai-brief-error"><strong>Error</strong> — ${escapeHtml(String(msg.error))}</p>`;
        break;
      }
      const text = typeof msg.text === 'string' ? msg.text : '';
      const thinking = typeof msg.thinking === 'string' ? msg.thinking : '';
      const thinkOpen = isPartial ? ' open' : '';
      const thinkBlock =
        thinking.trim().length > 0
          ? `<details class="ai-brief-thinking-details"${thinkOpen}><summary class="ai-brief-thinking-summary">Reasoning</summary><pre class="ai-brief-thinking-pre">${escapeHtml(thinking)}</pre></details>`
          : '';
      let mdBlock;
      if (text.trim().length > 0) {
        mdBlock = renderAiBriefMarkdown(text);
      } else if (thinking.trim().length > 0) {
        mdBlock = '<p class="ai-brief-muted mono-sm">Generating brief…</p>';
      } else {
        mdBlock = renderAiBriefMarkdown('');
      }
      body.innerHTML = `${thinkBlock}<div class="ai-brief-md">${mdBlock}</div>`;
      body.querySelectorAll('a[href^="http"]').forEach((a) => {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
      });
      break;
    }

    /* ── Connection status ─ */
    case 'status': {
      if (msg.connected === true)  setWsStatus('connected', 'Live');
      if (msg.connected === false) setWsStatus('disconnected', 'Disconnected');
      if (msg.reconnecting) setWsStatus('connecting', `Reconnecting #${msg.attempt}…`);
      if (Array.isArray(msg.watchlist)) initWatchlistBar(msg.watchlist, msg.symbol);
      break;
    }

    case 'position_update':
    case 'paper_position_update': {
      lastOpenPositions = Array.isArray(msg.positions) ? msg.positions : [];
      refreshOpenPositionOverlay();
      break;
    }

    /* ── Server-side NanoPine alerts ─ */
    case 'script_alert': {
      scripts?.ingestServerAlert?.(msg);
      break;
    }

    /* ── Heartbeat ─ */
    case 'heartbeat': {
      console.debug(`[hb] ${new Date(msg.ts).toISOString()} — clients: ${msg.clients}`);
      break;
    }
  }
}

const SIDEBAR_STORAGE_KEY = 'qt_sidebar_hidden';

const initSidebarToggle = () => {
  const btn = document.getElementById('btn-toggle-sidebar');
  const grid = document.getElementById('main-grid');
  if (!btn || !grid) return;

  const setHidden = (hidden) => {
    grid.classList.toggle('sidebar-hidden', hidden);
    btn.classList.toggle('active', hidden);
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, hidden ? '1' : '0');
    } catch {}
  };

  // Restore state
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (stored === '1') setHidden(true);
  } catch {}

  btn.addEventListener('click', () => {
    const isHidden = grid.classList.contains('sidebar-hidden');
    setHidden(!isHidden);
  });

  // Shortcut Ctrl+B
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      btn.click();
    }
  });
};

// ─── Imbalance helper ─────────────────────────────────────────────────────
const imbalanceRatio = (bids = [], asks = []) => {
  const bidVol = bids.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
  const askVol = asks.slice(0, 10).reduce((s, r) => s + r.qty * r.price, 0);
  const total = bidVol + askVol;
  return total > 0 ? bidVol / total : 0.5;
}

const initSidebarTabs = () => {
  const bar = document.querySelector('.sidebar-tab-bar');
  if (!bar) return;

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sidebar-tab');
    if (!btn || !bar.contains(btn)) return;
    const tabId = btn.dataset.tab;
    bar.querySelectorAll('.sidebar-tab').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.sidebar-tab-pane').forEach((pane) => {
      const on = pane.dataset.tabPane === tabId;
      pane.classList.toggle('is-active', on);
      pane.setAttribute('aria-hidden', on ? 'false' : 'true');
    });
    requestAnimationFrame(() => {
      if (tabId === 'live') {
        gauge.redraw();
      }
    });
  });

  document.querySelectorAll('.sidebar-tab-pane').forEach((pane) => {
    pane.setAttribute('aria-hidden', pane.classList.contains('is-active') ? 'false' : 'true');
  });

  requestAnimationFrame(() => {
    gauge.redraw();
  });
}

// ─── Force Resync ─────────────────────────────────────────────────────────
const requestForceResync = () => {
  if (ws?.readyState !== WebSocket.OPEN) return;
  console.info('[resync] requesting full candle resync from server…');
  ws.send(JSON.stringify({ type: 'force_resync' }));
};

// ─── Init ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initSymbolDropdown();
  const storedSym = localStorage.getItem(STORAGE_KEY_SYMBOL);
  if (storedSym) {
    syncUiWithSymbol(storedSym);
    updateUrlWithSymbol(storedSym);
  }

  obMgr.init();
  chart.init();
  chart.setLtpDisplayListener((p) => {
    const priceEl = document.getElementById('hdr-price');
    if (!priceEl) return;
    if (p == null || !Number.isFinite(p)) {
      priceEl.textContent = '—';
      return;
    }
    priceEl.textContent = fmtLtpMovement(p);
  });
  chart.setTfChangeHandler((tf) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_chart_tf', tf }));
    }
    scripts?.onTfChange(tf);
  });

  const initChartSettingsModal = () => {
    const btn = document.getElementById('btn-chart-settings');
    const modal = document.getElementById('chart-settings-modal');
    const closeBtn = document.getElementById('btn-close-modal');
    const navItems = modal?.querySelectorAll('.modal-nav-item');
    const panes = modal?.querySelectorAll('.settings-tab-pane');
    const titleEl = document.getElementById('settings-tab-title');
    
    if (!btn || !modal) return;

    const openModal = () => {
      modal.hidden = false;
      modal.removeAttribute('hidden');
      const activePane = modal.querySelector('.settings-tab-pane.active');
      const firstCheck = activePane?.querySelector('input[type="checkbox"]');
      if (firstCheck) firstCheck.focus();
    };

    const closeModal = () => {
      modal.hidden = true;
      modal.setAttribute('hidden', '');
      btn.focus();
    };

    const switchTab = (tabId) => {
      navItems.forEach(item => {
        const on = item.dataset.settingsTab === tabId;
        item.classList.toggle('active', on);
        item.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panes.forEach(pane => {
        pane.classList.toggle('active', pane.id === `tab-pane-${tabId}`);
      });
      if (titleEl) {
        const labels = { indicators: 'Indicators & Overlays', risk: 'Risk & Sizing', system: 'System Status' };
        titleEl.textContent = labels[tabId] || 'Settings';
      }
    };

    btn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    navItems.forEach(item => {
      item.addEventListener('click', () => switchTab(item.dataset.settingsTab));
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // ... (rest of keydown listeners stay same)

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        if (modal.hidden) openModal();
        else closeModal();
      } else if (e.key === 'Escape' && !modal.hidden) {
        e.preventDefault();
        closeModal();
      }
    });
  };

  initChartSettingsModal();
  initSidebarToggle();
  initSidebarTabs();

  scripts = new ScriptManager(chart);
  const scriptsHost = document.getElementById('nanopine-host');
  if (scriptsHost) scriptEditor = new ScriptEditor(scriptsHost, scripts);
  window.__nanopine = { manager: scripts, editor: scriptEditor };

  chart.setHistoryRequestHandler(({ tf, oldestOpenTime }) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'load_history', tf, oldestOpenTime }));
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.shiftKey && e.key === 'R') {
      e.preventDefault();
      requestForceResync();
    }
  });

  window.__chart = {
    manager: chart,
    candleMap: () => chart.candleMap,
    currentTf: () => chart.currentTf,
    dumpBar: (tf, openTimeMs) => {
      const arr = chart.candleMap[tf];
      if (!arr?.length) return null;
      return arr.find((c) => c.openTime === openTimeMs) ?? null;
    },
    dumpTail: (tf, n = 5) => {
      const arr = chart.candleMap[tf];
      if (!arr?.length) return [];
      return arr.slice(-n);
    },
    resync: requestForceResync,
  };

  connect();
});

// ─── Alert feed + toast ───────────────────────────────────────────────────
const _alertRows = [];
const _MAX_ALERTS = 200;
function pushAlertRow({ kind, icon, title, detail }) {
  const ts = new Date();
  const hh = String(ts.getHours()).padStart(2, '0');
  const mm = String(ts.getMinutes()).padStart(2, '0');
  const ss = String(ts.getSeconds()).padStart(2, '0');
  const row = { kind, icon, title, detail, time: `${hh}:${mm}:${ss}` };
  _alertRows.unshift(row);
  if (_alertRows.length > _MAX_ALERTS) _alertRows.length = _MAX_ALERTS;
  renderAlerts();
}
function renderAlerts() {
  const el = document.getElementById('alerts-feed');
  const counter = document.getElementById('alerts-count');
  if (!el) return;
  const colors = {
    long: '#26a69a', short: '#ef5350', flat: '#888',
    win: '#26a69a', loss: '#ef5350', reject: '#ff9800',
  };
  el.innerHTML = _alertRows.map((r) => `
    <div style="display:flex;gap:6px;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,0.04);">
      <div style="font-size:14px;line-height:14px;">${r.icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="color:${colors[r.kind] || '#ccc'};font-weight:600;font-size:11px;">${escapeHtml(r.title)}</div>
        <div style="color:#888;font-size:10px;margin-top:2px;">${escapeHtml(r.detail)}</div>
      </div>
      <div style="color:#666;font-size:10px;white-space:nowrap;">${r.time}</div>
    </div>
  `).join('');
  if (counter) counter.textContent = String(_alertRows.length);
}

let _toastContainer = null;
function showToast(text, kind = 'info') {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.style.cssText = `position:fixed;top:60px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;`;
    document.body.appendChild(_toastContainer);
  }
  const bg = kind === 'warn' ? 'rgba(255,152,0,0.95)'
    : kind === 'success' ? 'rgba(38,166,154,0.95)'
    : kind === 'error' ? 'rgba(239,83,80,0.95)'
    : 'rgba(60,80,100,0.95)';
  const t = document.createElement('div');
  t.style.cssText = `background:${bg};color:#fff;padding:8px 12px;border-radius:6px;font-family:'Roboto Mono',monospace;font-size:11px;box-shadow:0 4px 12px rgba(0,0,0,0.4);max-width:280px;opacity:0;transition:opacity .2s ease;`;
  t.textContent = text;
  _toastContainer.appendChild(t);
  requestAnimationFrame(() => { t.style.opacity = '1'; });
  setTimeout(() => {
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 250);
  }, 5500);
}
