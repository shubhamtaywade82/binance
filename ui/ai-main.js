import { ScriptManager } from './scripts/ui/script-manager.js';
import { ScriptEditor } from './scripts/ui/script-editor.js';
import { AiChat } from './ai-chat.js';

const setWsStatus = (state, text) => {
  const el = document.getElementById('ws-status');
  const txt = document.getElementById('ws-status-text');
  if (el)  el.className = `ws-status ${state}`;
  if (txt) txt.textContent = text;
};

const dashboardWebSocketUrl = () => {
  const fromEnv = import.meta.env?.VITE_DASHBOARD_WS_URL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const { protocol, host } = window.location;
  const wsScheme = protocol === 'https:' ? 'wss:' : 'ws:';
  if (import.meta.env.DEV) return `${wsScheme}//${host}/__dashboard_ws`;
  const port = import.meta.env?.VITE_DASHBOARD_WS_PORT ?? '4001';
  const hostname = window.location.hostname || 'localhost';
  return `${wsScheme}//${hostname}:${port}`;
};

const WS_URL = dashboardWebSocketUrl();
let ws = null;
let reconnectDelay = 1000;
let reconnectTimer = null;
let currentSymbol = '';

const marketContext = {
  symbol: '',
  price: null,
  signals: null,
  microstructure: null,
  aiBrief: null,
};

const dispatch = (msg) => {
  switch (msg.type) {
    case 'snapshot':
      currentSymbol = msg.symbol || '';
      marketContext.symbol = currentSymbol;
      document.getElementById('hdr-symbol').textContent = currentSymbol;
      if (msg.signals) marketContext.signals = msg.signals;
      if (msg.mark != null) marketContext.price = msg.mark;
      break;
    case 'signals':
      marketContext.signals = msg;
      if (msg.refPrice != null) marketContext.price = msg.refPrice;
      break;
    case 'microstructure':
      marketContext.microstructure = msg;
      break;
    case 'ai_brief':
      marketContext.aiBrief = msg;
      break;
    case 'ticker_24hr':
      if (msg.lastPrice != null) marketContext.price = msg.lastPrice;
      break;
  }
};

const connect = () => {
  setWsStatus('connecting', `Connecting… (${WS_URL})`);
  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => { setWsStatus('connected', 'Live'); reconnectDelay = 1000; });
  ws.addEventListener('close', () => { setWsStatus('disconnected', 'Reconnecting…'); scheduleReconnect(); });
  ws.addEventListener('error', () => { setWsStatus('disconnected', 'WS error — is the bot running?'); });
  ws.addEventListener('message', (ev) => {
    try { dispatch(JSON.parse(ev.data)); } catch { /* ignore parse errors */ }
  });
};

const scheduleReconnect = () => {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
};

document.addEventListener('DOMContentLoaded', () => {
  connect();

  const scriptsHost = document.getElementById('nanopine-host');
  if (scriptsHost) {
    const scripts = new ScriptManager(null);
    new ScriptEditor(scriptsHost, scripts);
  }

  const chatPanel = document.getElementById('ai-chat-panel');
  if (chatPanel) {
    new AiChat({
      messagesEl: document.getElementById('chat-messages'),
      inputEl: document.getElementById('chat-input'),
      sendBtn: document.getElementById('chat-send-btn'),
      clearBtn: document.getElementById('chat-clear-btn'),
      contextToggle: document.getElementById('chat-context-toggle'),
      nanopineToggle: document.getElementById('chat-nanopine-toggle'),
      getSymbol: () => currentSymbol || 'UNKNOWN',
    });
  }
});
