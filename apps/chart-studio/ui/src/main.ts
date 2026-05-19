import { ChartView } from './chart';
import { ProviderClient, type Candle, type SymbolRef } from './provider-client';
import { OrderBookPanel } from './panels/orderbook';
import { TradeTapePanel } from './panels/trade-tape';
import { SentimentPanel } from './panels/sentiment';
import { GlobalSearch } from './search/global-search';
import { ProviderSettings } from './settings/providers';
import { WatchlistPanel } from './watchlist/watchlist';
import { IndicatorPicker } from './indicators/picker';
import { AlertEngine } from './alerts/alerts';
import { AlertsPanel } from './alerts/panel';
import { ScriptManager } from './scripts/editor';
import { DrawingLayer, type DrawingTool } from './drawings/drawings';

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
  const chartContainer = document.getElementById('chart-container')! as HTMLDivElement;
  const obRoot = document.getElementById('orderbook')!;
  const obSpread = document.getElementById('ob-spread')!;
  const tapeRoot = document.getElementById('trade-tape')!;
  const sentimentRoot = document.getElementById('sentiment')!;
  const intervalBar = document.getElementById('interval-bar')!;
  const symbolLabel = document.getElementById('active-symbol-label')!;
  const watchlistRoot = document.getElementById('watchlist')!;

  const chart = new ChartView(chartContainer);
  const ob = new OrderBookPanel(obRoot, obSpread);
  const tape = new TradeTapePanel(tapeRoot);
  const sentiment = new SentimentPanel(sentimentRoot);
  const settings = new ProviderSettings(client);
  const watchlist = new WatchlistPanel(watchlistRoot, client);
  const indicatorPicker = new IndicatorPicker();
  const alertEngine = new AlertEngine(client);
  const scriptManager = new ScriptManager(chart, client);
  const drawings = new DrawingLayer(chart, chartContainer);

  let activeState: AppState | null = parseHash();
  let currentCandles: Candle[] = [];
  const unsubs: Array<() => void> = [];

  new AlertsPanel(alertEngine, () => (activeState ? { provider: activeState.provider, symbol: activeState.symbol } : null));

  // Indicator changes re-apply to the chart immediately.
  indicatorPicker.onChange((list) => chart.setIndicators(list));

  // Drawing tool buttons.
  document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => drawings.setTool(btn.dataset.tool as DrawingTool));
  });
  document.getElementById('drawings-clear')?.addEventListener('click', () => drawings.clear());
  drawings.onToolChange((tool) => {
    document.querySelectorAll<HTMLButtonElement>('.tool-btn[data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
  });

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
    watchlist.setActive(state.provider, state.symbol);
    drawings.setSymbol(state.provider, state.symbol);
    renderIntervals();
    tearDown();
    ob.reset({ lastUpdateId: 0, bids: [], asks: [], ts: 0 });
    tape.reset();
    sentiment.reset();
    currentCandles = [];
    scriptManager.setCandles([]);

    unsubs.push(client.streamCandles(
      state.provider, state.symbol, state.interval,
      (history) => {
        currentCandles = history;
        chart.setHistory(history);
        chart.setIndicators(indicatorPicker.current());
        scriptManager.setCandles(history);
      },
      (upd) => {
        chart.updateCandle(upd.candle);
        const last = currentCandles[currentCandles.length - 1];
        if (last && last.openTime === upd.candle.openTime) currentCandles[currentCandles.length - 1] = upd.candle;
        else currentCandles.push(upd.candle);
        if (upd.isFinal) scriptManager.updateCandle(upd.candle, currentCandles);
      },
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

  new GlobalSearch(
    client,
    (ref) => applyState({ provider: ref.provider, symbol: ref.symbol, interval: activeState?.interval ?? '1m' }),
    (ref) => watchlist.add(ref),
  );

  watchlist.onSelect((ref: SymbolRef) => {
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
