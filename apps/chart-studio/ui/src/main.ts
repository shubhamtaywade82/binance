import { ChartView } from './chart';
import { ProviderClient, type Candle, type SymbolRef } from './provider-client';
import { OrderBookPanel } from './panels/orderbook';
import { TradeTapePanel } from './panels/trade-tape';
import { SentimentPanel } from './panels/sentiment';
import { GlobalSearch } from './search/global-search';
import { ProviderSettings } from './settings/providers';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

interface AppState {
  provider: string;
  symbol: string;
  interval: string;
}

const parseHash = (): AppState | null => {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  const m = h.match(/^([^:]+):(.+?)@(.+)$/);
  if (!m) return null;
  return { provider: m[1]!, symbol: m[2]!, interval: m[3]! };
};

const writeHash = (s: AppState): void => {
  const target = `#${s.provider}:${s.symbol}@${s.interval}`;
  if (location.hash !== target) location.hash = target;
};

const main = (): void => {
  const client = new ProviderClient();
  const chartContainer = document.getElementById('chart-container')!;
  const obRoot = document.getElementById('orderbook')!;
  const obSpread = document.getElementById('ob-spread')!;
  const tapeRoot = document.getElementById('trade-tape')!;
  const sentimentRoot = document.getElementById('sentiment')!;
  const intervalBar = document.getElementById('interval-bar')!;
  const symbolLabel = document.getElementById('active-symbol-label')!;

  const chart = new ChartView(chartContainer);
  const ob = new OrderBookPanel(obRoot, obSpread);
  const tape = new TradeTapePanel(tapeRoot);
  const sentiment = new SentimentPanel(sentimentRoot);
  const settings = new ProviderSettings(client);

  let activeState: AppState | null = parseHash();
  const unsubs: Array<() => void> = [];

  const renderIntervals = (): void => {
    intervalBar.innerHTML = INTERVALS.map((i) =>
      `<button data-iv="${i}" class="${activeState?.interval === i ? 'active' : ''}">${i}</button>`
    ).join('');
    intervalBar.querySelectorAll<HTMLButtonElement>('button[data-iv]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!activeState) return;
        applyState({ ...activeState, interval: b.dataset.iv! });
      });
    });
  };

  const tearDown = (): void => {
    for (const u of unsubs) try { u(); } catch { /* noop */ }
    unsubs.length = 0;
  };

  const applyState = (state: AppState): void => {
    activeState = state;
    writeHash(state);
    symbolLabel.textContent = `${state.provider} · ${state.symbol} · ${state.interval}`;
    renderIntervals();
    tearDown();
    ob.reset({ lastUpdateId: 0, bids: [], asks: [], ts: 0 });
    tape.reset();
    sentiment.reset();

    unsubs.push(client.streamCandles(
      state.provider, state.symbol, state.interval,
      (history) => chart.setHistory(history),
      (upd) => chart.updateCandle(upd.candle),
    ));
    unsubs.push(client.streamDepth(
      state.provider, state.symbol,
      (snap) => ob.reset(snap),
      (delta) => ob.applyDelta(delta),
    ));
    unsubs.push(client.streamTrades(state.provider, state.symbol, (t) => {
      tape.push(t);
      sentiment.push(t);
    }));
  };

  new GlobalSearch(client, (ref: SymbolRef) => {
    applyState({ provider: ref.provider, symbol: ref.symbol, interval: activeState?.interval ?? '1m' });
  });

  window.addEventListener('hashchange', () => {
    const next = parseHash();
    if (next && (!activeState || next.provider !== activeState.provider || next.symbol !== activeState.symbol || next.interval !== activeState.interval)) {
      applyState(next);
    }
  });

  // Bootstrap: prefer hash; else wait for providers to come online and pick a sensible default.
  if (activeState) {
    applyState(activeState);
  } else {
    let bootstrapped = false;
    const tryBootstrap = (): void => {
      if (bootstrapped) return;
      const providers = settings.providers();
      const online = providers.find((p) => p.online);
      if (!online) return;
      bootstrapped = true;
      const defaultSymbol = online.provider.startsWith('binance') ? 'BTCUSDT' : null;
      if (defaultSymbol) {
        applyState({ provider: online.provider, symbol: defaultSymbol, interval: '1m' });
      } else {
        symbolLabel.textContent = `Press ⌘K to search ${online.displayName}`;
        renderIntervals();
      }
    };
    void settings.refresh().then(tryBootstrap);
    setInterval(tryBootstrap, 1500);
  }

  renderIntervals();
};

main();
