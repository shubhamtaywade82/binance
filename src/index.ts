import Redis from 'ioredis';
import { MultiTimeframeStore } from './binance/multi-tf-store';
import { LocalOrderBook } from './binance/orderbook';
import { AggTradeTape } from './binance/trade-tape';
import { loadConfig, multiplexBinanceSymbols } from './config';
import { createDashboardBridge, type DashboardBridge } from './dashboard/bridge';
import { createAppLogger } from './logging/app-logger';
import { HybridOrchestrator } from './orchestrator';
import { Lifecycle } from './lifecycle';
import { PerSymbolMarketFeeds } from './binance/per-symbol-market-feeds';
import { OrderBookSnapshotRing } from './liquidity/order-book-snapshot-ring';
import type { InstrumentPrecision } from './mapping/precision';
import { ControlHttpServer } from './control/http-server';
import { getRedisClient, closeRedisClient } from './services/redis';
import { createExecutionRuntime } from './execution/create-runtime';
import { CoinDcxFuturesClient } from './coindcx/futures-client';
import { defaultEventBus } from './core/events/event-bus';
import { EventStore } from './persistence/event-store';
import { MarketEventPublisher } from './market/distribution/event-publisher';
import { mergeMultiplexCallbacks } from './binance/merge-multiplex-callbacks';

import { ActorSystem } from './core/actors/actor-system';
import { SignalToOrderBridge } from './core/execution/signal-to-order-bridge';
import { ExecutionBridge } from './core/execution/execution-bridge';
import { TrailingStopManager } from './core/execution/trailing-stop-manager';
import { StructureExitManager } from './core/execution/structure-exit-manager';
import { TimeStopManager } from './core/execution/time-stop-manager';
import { SignalReversalExitManager } from './core/execution/signal-reversal-exit-manager';
import { FundingExitManager } from './core/execution/funding-exit-manager';
import { TpLadderManager } from './core/execution/tp-ladder-manager';
import { PositionCloseBridge } from './core/execution/position-close-bridge';
import { EventToPostgresBridge } from './core/persistence/event-to-postgres-bridge';
import { LiveAccountPoller } from './core/execution/live-account-poller';
import { CoinDcxUserDataWs } from './coindcx/user-data-ws';
import { MarkPriceBridge } from './core/execution/mark-price-bridge';
import { SignalAllocator } from './core/execution/signal-allocator';
import { reconcilePositionsAtStartup } from './core/execution/reconciliation';
import { FreshnessWatchdog } from './core/execution/freshness-watchdog';
import { FillMetadataStore } from './core/execution/fill-metadata-store';
import { normalizeSymbol } from './mapping/symbol-normalize';
import type { DomainEvent } from '@coindcx/contracts';
import { TelegramNotifier } from './services/telegram-notifier';
import { SelfLearningRuntime } from './self-learning/runtime';

let orch: HybridOrchestrator | null = null;
let actorSystem: ActorSystem | null = null;
let dashboardBridge: DashboardBridge | null = null;
let controlServer: ControlHttpServer | null = null;
let selfLearning: SelfLearningRuntime | null = null;

const main = async (): Promise<void> => {
  const cfg = loadConfig();
  const log = createAppLogger(cfg);

  if (cfg.BINANCE_PRODUCT === 'usdm_demo') {
    log.warn('binance_usdm_demo_product', {
      hint:
        'BINANCE_PRODUCT=usdm_demo uses REST https://demo-fapi.binance.com (virtual balances) and WS wss://fstream.binancefuture.com per Binance USD-M testnet docs. Liquidity and fills are not comparable to mainnet fapi.',
    });
  }
  if (cfg.SHADOW_MODE) {
    log.warn('shadow_mode_active', {
      hint:
        'SHADOW_MODE=true: PositionManager logs open/close intent but does not call the execution adapter (no exchange orders). Strategy and market data still run. Flatten real exchange positions before using on a funded account.',
    });
  }
  if (cfg.BINANCE_FUTURES_TESTNET && cfg.BINANCE_PRODUCT === 'usdm') {
    log.warn('binance_futures_testnet_liquidity', {
      hint:
        'BINANCE_FUTURES_TESTNET=true routes USD-M to Binance test/demo infrastructure. Book depth, queue priority, and fill quality differ sharply from mainnet fapi — do not treat simulated or testnet PnL as predictive of live performance.',
    });
  }

  if (
    cfg.EXECUTION_MODE === 'live' &&
    cfg.BINANCE_EXECUTION_ADAPTER &&
    !cfg.BINANCE_FUTURES_TESTNET &&
    cfg.BINANCE_PRODUCT === 'usdm' &&
    !cfg.CONFIRMED_LIVE_TRADING
  ) {
    log.warn('live_mainnet_missing_confirm', {
      hint:
        'Mainnet Binance live execution is configured but CONFIRMED_LIVE_TRADING (or CONFIRMED_LIVE) is not true. createExecutionRuntime will throw until this interlock is set.',
    });
  }

  // C-1 single-path interlock: live mode MUST go through the event-bus stack.
  // The legacy HybridOrchestrator strategy/position-dispatch path still exists
  // (see TODO_CLEANUP_LEGACY_EXECUTION markers in src/orchestrator.ts) but is
  // gated off whenever EVENT_BUS_EXECUTION_ENABLED=true so the two paths never
  // compete on a shared EventBus. Live without the event bus would mean orders
  // bypass RiskEngine / SignalAllocator / cooldown / opposite-side guard.
  if (cfg.EXECUTION_MODE === 'live' && !cfg.EVENT_BUS_EXECUTION_ENABLED) {
    throw new Error(
      'EVENT_BUS_EXECUTION_ENABLED must be true when EXECUTION_MODE=live. ' +
      'The legacy HybridOrchestrator dispatch path bypasses the RiskEngine, ' +
      'SignalAllocator, opposite-side guard, and cooldown. ' +
      'Set EVENT_BUS_EXECUTION_ENABLED=true (or run paper mode for legacy-path development).',
    );
  }

  // H-6: live mode requires explicit, non-zero values for the cardinal risk
  // caps. Defaults of 0 / Infinity were originally intentional for paper
  // development but make production runs unbounded: a stuck or runaway signal
  // path can place an unlimited series of unbounded-size orders. Forcing
  // operators to set these in env before going live makes the trade-off
  // visible.
  if (cfg.EXECUTION_MODE === 'live') {
    const liveMisconfig: string[] = [];
    if (!cfg.MAX_NOTIONAL_USDT || cfg.MAX_NOTIONAL_USDT <= 0) {
      liveMisconfig.push('MAX_NOTIONAL_USDT must be > 0 (per-position notional cap)');
    }
    if (!cfg.MAX_OPEN_POSITIONS || cfg.MAX_OPEN_POSITIONS <= 0) {
      liveMisconfig.push('MAX_OPEN_POSITIONS must be > 0');
    }
    if (!cfg.DAILY_DRAWDOWN_KILL_PCT || cfg.DAILY_DRAWDOWN_KILL_PCT <= 0) {
      liveMisconfig.push('DAILY_DRAWDOWN_KILL_PCT must be > 0 (e.g. 0.05 = 5% daily drawdown halt)');
    }
    if (liveMisconfig.length > 0) {
      throw new Error(
        'Live trading requires explicit risk caps. Missing or zero:\n  - ' +
        liveMisconfig.join('\n  - ') +
        '\nSet each in your .env (or .env.secrets / .env.live).',
      );
    }
  }

  const lifecycle = new Lifecycle({
    defaultTimeoutMs: cfg.SHUTDOWN_TIMEOUT_MS,
    forceExitMs: cfg.SHUTDOWN_FORCE_EXIT_MS,
    log,
  });
  lifecycle.attachProcessHandlers(log);

  const orderBookSnapshotRing = new OrderBookSnapshotRing({
    depthLevels: Math.max(10, cfg.BINANCE_DEPTH_LEVELS || 20),
  });

  const cdcx = new CoinDcxFuturesClient({
    apiKey: cfg.COINDCX_API_KEY,
    apiSecret: cfg.COINDCX_API_SECRET,
    apiBaseUrl: cfg.API_BASE_URL,
    readOnly: cfg.READ_ONLY,
  });
  const execution = createExecutionRuntime(cfg, cdcx);

  const eventPublisher = new MarketEventPublisher(defaultEventBus);
  const eventPublisherCallbacks = eventPublisher.getCallbacks() as any;

  selfLearning = new SelfLearningRuntime({
    enabled: cfg.SELF_LEARNING_ENABLED,
    paperOnly: cfg.SELF_LEARNING_PAPER_ONLY,
    executionMode: cfg.EXECUTION_MODE,
    intervalMs: cfg.SELF_LEARNING_INTERVAL_MS,
    ollamaUrl: cfg.SELF_LEARNING_OLLAMA_URL,
    ollamaModel: cfg.SELF_LEARNING_OLLAMA_MODEL,
  }, defaultEventBus, getRedisClient(cfg.REDIS_URL), log);
  await selfLearning.start();
  lifecycle.register('self_learning', () => selfLearning?.stop(), { timeoutMs: 500 });

  const telegram = new TelegramNotifier(cfg, defaultEventBus, log);
  telegram.start();
  // H-16: clear the digest timer + drain pending sends on shutdown.
  lifecycle.register('telegram_notifier', () => telegram.stop(), { timeoutMs: 500 });

  if (execution.pgWriter) {
    const eventStore = new EventStore(execution.pgWriter, defaultEventBus);
    eventStore.startRecording();
  }

  actorSystem = new ActorSystem(cfg, defaultEventBus);
  const allSymbols = multiplexBinanceSymbols(cfg);
  for (const sym of allSymbols) {
    actorSystem.spawnSymbolActor(sym);
  }

  // Mandatory startup reconciliation — MUST run before any strategy / bridge
  // wiring or the first kline close could place an order against unknown
  // exchange exposure. On `EXECUTION_MODE=live` a transport failure THROWS:
  // the bot refuses to start rather than trade against an unverified account.
  // Paper mode reads the local PaperExecutionAdapter (wallet.json was already
  // reloaded inside createExecutionRuntime), so this is a fast in-memory pass.
  const reconciled = await reconcilePositionsAtStartup(
    execution,
    cfg,
    allSymbols,
    log,
  );
  if (reconciled.positions.length > 0) {
    actorSystem.getRiskEngine().seedPositions(reconciled.positions);
    log.info('risk_engine_seeded', {
      positions: reconciled.positions.length,
      source: reconciled.source,
    });
  } else {
    log.info('risk_engine_seed_empty', { source: reconciled.source });
  }
  defaultEventBus.publish({
    id: `system-reconciled-${Date.now()}`,
    type: 'system.reconciled',
    ts: Date.now(),
    source: 'startup',
    payload: {
      positionsSeeded: reconciled.positions.length,
      source: reconciled.source,
      symbols: reconciled.positions.map((p) => p.symbol),
      errors: reconciled.errors,
    },
  });

  if (cfg.EVENT_BUS_EXECUTION_ENABLED) {
    const adapter = execution.paperAdapter ?? execution.cdcxAdapter ?? execution.adapter;
    if (!adapter) {
      log.warn('event_bus_execution_no_adapter', {
        hint: 'EVENT_BUS_EXECUTION_ENABLED=true but no execution adapter resolved. Bridges not wired.',
      });
    } else {
      const lastPriceBySymbol = new Map<string, number>();
      defaultEventBus.subscribe('market.kline.closed', (e: DomainEvent<any>) => {
        if (e.symbol && e.payload?.close) lastPriceBySymbol.set(e.symbol, e.payload.close);
      });
      defaultEventBus.subscribe('market.bookticker', (e: DomainEvent<any>) => {
        if (e.symbol && e.payload?.bestBidPrice && e.payload?.bestAskPrice) {
          lastPriceBySymbol.set(e.symbol, (e.payload.bestBidPrice + e.payload.bestAskPrice) / 2);
        }
      });
      new SignalToOrderBridge(cfg, defaultEventBus, {
        lastPrice: (s) => lastPriceBySymbol.get(s) ?? null,
      }, { cooldownMs: cfg.EVENT_BUS_ORDER_COOLDOWN_MS });
      if ((cfg as any).SIGNAL_ALLOCATOR_ENABLED) {
        new SignalAllocator(cfg, defaultEventBus, actorSystem.getRiskEngine(), {
          flushDelayMs: (cfg as any).SIGNAL_ALLOCATOR_FLUSH_MS,
        });
        log.info('signal_allocator_wired', {
          flushMs: (cfg as any).SIGNAL_ALLOCATOR_FLUSH_MS,
        });
      }
      // C-7: stale-feed risk-off. Watchdog publishes system.stale / .fresh
      // per symbol; RiskEngine subscribes and rejects orders for stale feeds.
      const freshnessWatchdog = new FreshnessWatchdog(defaultEventBus, {
        staleAfterMs: Number((cfg as any).STALE_FEED_THRESHOLD_MS) || 30_000,
        checkIntervalMs: Number((cfg as any).STALE_FEED_CHECK_INTERVAL_MS) || 5_000,
        log,
      });
      freshnessWatchdog.start();
      lifecycle.register('freshness_watchdog', () => freshnessWatchdog.stop(), { timeoutMs: 500 });

      // C-9: fill-metadata store backs exit-manager re-arming after a crash.
      // ExecutionBridge upserts on every successful fill; we replay the
      // store below (after all exit managers are constructed) to publish
      // synthetic `execution.order.filled` events so the trail / TP ladder /
      // structure / time-stop managers register the positions they would
      // have known about pre-crash.
      const fillMetadataStore = new FillMetadataStore(
        (cfg as any).FILL_METADATA_PATH || './data/fills.json',
      );
      new ExecutionBridge(cfg, defaultEventBus, adapter, fillMetadataStore);
      new PositionCloseBridge(defaultEventBus, adapter);
      if (execution.pgWriter) {
        new EventToPostgresBridge(cfg, defaultEventBus, execution.pgWriter);
      }

      // Live mode: poll CoinDCX REST for wallet + positions and project onto
      // the same event/Postgres/Redis shape paper mode emits. WS user-data
      // stream replacement can land later without changing consumers.
      // Live adapter has no internal book ticker feed — wire MarkPriceBridge
      // so onMark is fed from Binance market.mark / market.bookticker. Required
      // for exit managers (trail / structure) that consult adapter marks.
      if (cfg.EXECUTION_MODE === 'live' && execution.cdcxAdapter) {
        new MarkPriceBridge(defaultEventBus, execution.cdcxAdapter);
      }

      if (cfg.EXECUTION_MODE === 'live' && execution.cdcxAdapter) {
        const pollMs = Math.max(1000, (cfg.PAPER_EQUITY_SNAPSHOT_SEC || 5) * 1000);
        const staticFx = { getInrPerUsdt: () => Number(cfg.INR_PER_USDT) || 98 };
        const poller = new LiveAccountPoller(defaultEventBus, execution.cdcxAdapter, {
          pollMs,
          pgWriter: execution.pgWriter,
          redisState: (execution as any).redisState,
          fxRate: staticFx,
          // H-5: drop missConfirms from 3 to 1 — when the user-data WS is
          // up it is the authoritative source for closes. The poller now
          // only runs while WS is disconnected (see onConnectionChange);
          // a single empty poll while disconnected is enough to publish a
          // close. Previous 3×5s = up to 15s of stale exposure window.
          missConfirms: 1,
        });
        poller.start();
        lifecycle.register('live_account_poller', () => poller.stop(), { timeoutMs: 1000 });
        log.info('live_account_poller_started', { pollMs });

        // Real-time user-data WS — replaces poller for instant fills + balance.
        // Poller remains as fallback whenever the WS is disconnected.
        if (cfg.COINDCX_API_KEY.trim() && cfg.COINDCX_API_SECRET.trim()) {
          const userWs = new CoinDcxUserDataWs({
            apiKey: cfg.COINDCX_API_KEY,
            apiSecret: cfg.COINDCX_API_SECRET,
            log,
            eventBus: defaultEventBus,
            onConnectionChange: (connected) => {
              if (connected) poller.stop();
              else poller.start();
            },
            onBalanceDelta: () => poller.requestFreshSnapshot(),
          });
          userWs.start();
          lifecycle.register('coindcx_userdata_ws', () => userWs.stop(), { timeoutMs: 1500 });
          log.info('coindcx_userdata_ws_started', {});
        }
      }
      // TpLadderManager fires partial closes at strategy-defined absolute price
      // targets. AdaptiveStrategy uses it; SeykotaTrendModule's inline partialTpR
      // path (inside TrailingStopManager) remains for the swing-only profile.
      new TpLadderManager(defaultEventBus, { intrabar: Boolean((cfg as any).SEYKOTA_TRAIL_INTRABAR) });

      if ((cfg as any).SEYKOTA_ENABLED || (cfg as any).ADAPTIVE_STRATEGY_ENABLED) {
        const intrabar = Boolean((cfg as any).SEYKOTA_TRAIL_INTRABAR);
        new TrailingStopManager(defaultEventBus, {
          atrMult: (cfg as any).SEYKOTA_ATR_MULT,
          defaultAtrPct: (cfg as any).SEYKOTA_MIN_ATR_PCT,
          klineOnly: !intrabar,
          partialTpR: (cfg as any).PARTIAL_TP_ENABLED ? Number((cfg as any).PARTIAL_TP_R) : 0,
          partialTpPct: Number((cfg as any).PARTIAL_TP_FRACTION) || 0.5,
          smcExitEnabled: false, // handled by StructureExitManager below
          watermarkActivationPct: Number((cfg as any).WATERMARK_ACTIVATION_PCT) || 0.005,
          dropFromPeakPct: Number((cfg as any).DROP_FROM_PEAK_PCT) || 0.4,
        });

        if ((cfg as any).STRUCTURE_EXIT_ENABLED) {
          new StructureExitManager(defaultEventBus, {
            swingLookback: Number((cfg as any).STRUCTURE_SWING_LOOKBACK) || 5,
            bufferBars: Math.max(60, Number((cfg as any).STRUCTURE_SWING_LOOKBACK) * 12),
            checkSignals: (cfg as any).STRUCTURE_EXIT_CHECK_SIGNALS ?? true,
          });
        }
        if ((cfg as any).TIME_STOP_ENABLED) {
          new TimeStopManager(defaultEventBus, {
            barsThreshold: Number((cfg as any).TIME_STOP_BARS) || 24,
            thresholdPct: Number((cfg as any).TIME_STOP_THRESHOLD_PCT) || 0.5,
          });
        }
        if ((cfg as any).SIGNAL_REVERSAL_EXIT_ENABLED) {
          new SignalReversalExitManager(defaultEventBus, {
            minConfidence: Number((cfg as any).MIN_SIGNAL_CONFIDENCE) || 0.5,
          });
        }
        if ((cfg as any).FUNDING_EXIT_ENABLED) {
          // Prefer the paper adapter's FundingEngine when running paper. For
          // live, the engine doesn't exist in execution runtime; spin one up
          // here against the Binance REST API since CoinDCX doesn't expose
          // funding rates and Binance is the price source either way.
          let fundingEngine = (execution as any).paperFundingEngine ?? (execution.paperAdapter as any)?.opts?.funding;
          if (!fundingEngine && cfg.EXECUTION_MODE === 'live') {
            const { FundingEngine } = await import('./execution/paper/funding');
            const { binanceRestBase } = await import('./config');
            fundingEngine = new FundingEngine({
              binanceRestBase: binanceRestBase(cfg),
              pollSec: cfg.PAPER_FUNDING_POLL_SEC,
            });
            for (const s of multiplexBinanceSymbols(cfg)) fundingEngine.trackSymbol(s);
            fundingEngine.start();
            lifecycle.register('live_funding_engine', () => fundingEngine.stop(), { timeoutMs: 1000 });
          }
          if (fundingEngine) {
            new FundingExitManager(defaultEventBus, fundingEngine, {
              perTickThresholdBps: Number((cfg as any).FUNDING_EXIT_THRESHOLD_BPS) || 50,
            });
          } else {
            log.warn('funding_exit_no_engine', { hint: 'paper adapter did not expose FundingEngine' });
          }
        }
        const strategyTag = (cfg as any).ADAPTIVE_STRATEGY_ENABLED ? 'adaptive' : 'seykota';
        log.info('exit_managers_wired', {
          strategy: strategyTag,
          htf: (cfg as any).SEYKOTA_HTF,
          atrMult: (cfg as any).SEYKOTA_ATR_MULT,
          intrabarTrail: Boolean((cfg as any).SEYKOTA_TRAIL_INTRABAR),
          structureExit: Boolean((cfg as any).STRUCTURE_EXIT_ENABLED),
          structureCheckSignals: (cfg as any).STRUCTURE_EXIT_CHECK_SIGNALS ?? true,
          timeStop: Boolean((cfg as any).TIME_STOP_ENABLED),
          timeStopThreshold: Number((cfg as any).TIME_STOP_THRESHOLD_PCT) || 0.5,
          reversalExit: Boolean((cfg as any).SIGNAL_REVERSAL_EXIT_ENABLED),
          fundingExit: Boolean((cfg as any).FUNDING_EXIT_ENABLED),
          watermarkActivation: Number((cfg as any).WATERMARK_ACTIVATION_PCT) || 0.005,
          dropFromPeak: Number((cfg as any).DROP_FROM_PEAK_PCT) || 0.4,
        });
      }

      // C-9: re-emit synthetic execution.order.filled events for every
      // reconciled position so the trail / TP ladder / structure / time-stop
      // managers register them. The fill-metadata store (persisted on every
      // live fill) feeds the strategy-side metadata (atr, tp ladder, regime,
      // initial SL/TP) so the re-armed exit logic matches the pre-crash
      // strategy intent as closely as possible. Without this, exit managers
      // start blank and only react to NEW fills — positions opened pre-crash
      // would hold forever with no trailing or time-stop protection.
      const reEmitTs = Date.now();
      let rearmWithMetadata = 0;
      for (const pos of reconciled.positions) {
        const meta = fillMetadataStore.bySymbol(pos.symbol).find((m) => m.side === pos.side);
        if (meta) rearmWithMetadata += 1;
        defaultEventBus.publish({
          id: `rearm-${pos.symbol}-${reEmitTs}`,
          type: 'execution.order.filled',
          ts: reEmitTs,
          source: 'startup-rearm',
          symbol: pos.symbol,
          payload: {
            orderId: meta?.orderId ?? `rearm-${pos.symbol}-${reEmitTs}`,
            symbol: pos.symbol,
            side: pos.side,
            quantity: pos.quantity,
            price: pos.entryPrice,
            feeUsdt: 0,
            slippageUsdt: 0,
            latencyMs: 0,
            stopLoss: meta?.stopLoss,
            takeProfit: meta?.takeProfit,
            strategyId: meta?.strategyId,
            tpLadder: meta?.tpLadder,
            maxHoldBars: meta?.maxHoldBars,
            regime: meta?.regime,
            modeId: meta?.modeId,
            atrAtEntry: meta?.atrAtEntry,
            openedAt: meta?.openedAt ?? reEmitTs,
            reason: 'STARTUP_REARM',
          },
        });
      }
      if (reconciled.positions.length > 0) {
        log.info('exit_managers_rearm', {
          positions: reconciled.positions.length,
          withMetadata: rearmWithMetadata,
          withoutMetadata: reconciled.positions.length - rearmWithMetadata,
        });
      }

      log.info('event_bus_execution_wired', { adapter: adapter.name });

      // Push event-bus state to the dashboard WS so the chart + sidebar render
      // entries/exits/trails in real time without polling the adapter.
      if (dashboardBridge) {
        const bridge = dashboardBridge;
        defaultEventBus.subscribe('execution.order.filled', (e: DomainEvent<any>) =>
          bridge.broadcast({ type: 'position_opened', ...e.payload }),
        );
        defaultEventBus.subscribe('execution.position.closed', (e: DomainEvent<any>) =>
          bridge.broadcast({ type: 'position_closed', ...e.payload }),
        );
        defaultEventBus.subscribe('execution.order.rejected', (e: DomainEvent<any>) =>
          bridge.broadcast({ type: 'order_rejected', ...e.payload }),
        );
        defaultEventBus.subscribe('trail.update', (e: DomainEvent<any>) =>
          bridge.broadcast({ type: 'trail_update', ...e.payload }),
        );
        defaultEventBus.subscribe('strategy.signal', (e: DomainEvent<any>) =>
          bridge.broadcast({ type: 'strategy_signal', symbol: e.symbol, ...e.payload }),
        );
        defaultEventBus.subscribe('wallet.update', (e: DomainEvent<any>) =>
          bridge.broadcast({ type: 'wallet', ...e.payload }),
        );
        defaultEventBus.subscribe('position_update', (e: DomainEvent<any>) =>
          bridge.broadcast({ type: 'paper_position_update', positions: (e.payload as any)?.positions ?? [], mode: (e.payload as any)?.mode }),
        );
      }
    }
  }

  if (cfg.DASHBOARD_ENABLED) {
    const store = new MultiTimeframeStore({
      maxBars: cfg.DASHBOARD_STORE_MAX_BARS,
      onAnomalousBar: (symbol, tf, candle, medianRange) => {
        log.warn('anomalous_candle', {
          symbol,
          tf,
          openTime: new Date(candle.openTime).toISOString(),
          high: candle.high,
          low: candle.low,
          range: Math.abs(candle.high - candle.low),
          medianRange,
          ratio: medianRange > 0 ? (Math.abs(candle.high - candle.low) / medianRange).toFixed(1) : '∞',
        });
      },
    });
    const orderbook = new LocalOrderBook();
    const tradeTape = new AggTradeTape(1000);
    const precisionBySymbol = new Map<string, InstrumentPrecision>();
    const mxSyms = multiplexBinanceSymbols(cfg);
    const marketFeeds =
      mxSyms.length > 1
        ? new PerSymbolMarketFeeds(mxSyms, {
            tapeCapacity: 1000,
            primarySymbol: cfg.BINANCE_SYMBOL,
            primaryBook: orderbook,
            primaryTape: tradeTape,
          })
        : null;
    const redis = getRedisClient(cfg.REDIS_URL);
    dashboardBridge = createDashboardBridge(cfg, log, {
      store,
      orderbook,
      tradeTape,
      marketFeeds,
      orderBookSnapshotRing,
      precisionBySymbol,
      redis,
      paperWallet: async () => {
        const adapter = execution.paperAdapter || execution.cdcxAdapter || execution.adapter;
        if (adapter.getWalletState) return adapter.getWalletState();
        return null;
      },
      paperPositions: async () => {
        const adapter = execution.paperAdapter || execution.cdcxAdapter || execution.adapter;
        if (adapter.getOpenPositions) return adapter.getOpenPositions();
        return [];
      },
      livePositions: () => orch?.getDashboardPositions() ?? null,
      subscribeSymbol: (sym) => {
        const mx = orch?.getMultiplexWs();
        if (mx) {
          const streams = [
            `${sym.toLowerCase()}@kline_1m`,
            `${sym.toLowerCase()}@kline_5m`,
            `${sym.toLowerCase()}@kline_15m`,
            `${sym.toLowerCase()}@kline_1h`,
            `${sym.toLowerCase()}@kline_4h`,
            `${sym.toLowerCase()}@kline_1d`,
            `${sym.toLowerCase()}@markPrice`,
            `${sym.toLowerCase()}@bookTicker`,
            `${sym.toLowerCase()}@aggTrade`,
          ];
          mx.subscribe(streams);
          // Also spawn a SymbolActor so it starts processing/storing events
          actorSystem?.spawnSymbolActor(sym);
        }
      },
    });

    const activeAdapter = execution.paperAdapter || execution.cdcxAdapter || execution.adapter;
    if (activeAdapter.setOnTradeClose) {
      activeAdapter.setOnTradeClose((trade) => {
        // Mirror to dashboard UI (paper trade list).
        dashboardBridge!.broadcastPaperTrade(trade);
        // CRITICAL: emit event-bus close so RiskEngine, TpLadderManager,
        // TrailingStopManager, strategy in-position flags release.
        // Without this, adapter-internal REVERSAL / LIQUIDATION silently
        // closes positions and downstream state goes stale → strategy
        // keeps emitting same-symbol orders → adapter records REVERSAL on
        // next flip → death spiral.
        // Canonicalise: the CoinDCX live adapter populates trade.symbol with
        // 'B-SOL_USDT'-style pairs; exit managers + RiskEngine key by canonical
        // 'SOLUSDT'. Without this, the close event arrives under the wrong key
        // and the trailing stop / risk exposure never releases.
        const closeSymbol = normalizeSymbol((trade as any).symbol ?? (trade as any).pair);
        defaultEventBus.publish({
          id: `adapter-close-${trade.orderId}-${trade.closedAt}`,
          type: 'execution.position.closed',
          ts: trade.closedAt,
          source: `execution:${activeAdapter.name}:adapter-internal`,
          symbol: closeSymbol,
          payload: {
            orderId: trade.orderId,
            symbol: closeSymbol,
            side: trade.side,
            entryPrice: trade.entryPrice,
            exitPrice: trade.exitPrice,
            quantity: trade.quantity,
            reason: trade.reason,
            netUsdt: trade.netUsdt,
            grossUsdt: trade.grossUsdt,
            feesUsdt: trade.feesUsdt,
            fundingUsdt: trade.fundingUsdt,
            openedAt: trade.openedAt,
            closedAt: trade.closedAt,
            leverage: trade.leverage,
          },
        });
      });
    }

    orch = new HybridOrchestrator(cfg, log, {
      cdcx,
      execution,
      store,
      orderbook,
      tradeTape,
      marketFeeds: marketFeeds ?? undefined,
      multiplexSidecar: dashboardBridge.multiplexSidecar ? mergeMultiplexCallbacks(dashboardBridge.multiplexSidecar, eventPublisherCallbacks) : eventPublisherCallbacks,
      orderBookSnapshotRing,
      precisionBySymbol,
    });
  } else {
    orch = new HybridOrchestrator(cfg, log, { 
      cdcx, 
      execution, 
      orderBookSnapshotRing, 
      multiplexSidecar: eventPublisherCallbacks 
    });
  }

  const mx = orch.getMultiplexWs();
  if (mx) {
    lifecycle.register('multiplex_ws', () => mx.stop(), { timeoutMs: 3000 });
  }
  lifecycle.register('orchestrator', () => orch!.stop(), { timeoutMs: 3000 });
  if (actorSystem) {
    lifecycle.register('actor_system', () => actorSystem!.shutdown(), { timeoutMs: 2000 });
  }
  if (dashboardBridge) {
    lifecycle.register('dashboard', () => dashboardBridge!.stop(), { timeoutMs: 3000 });
    defaultEventBus.subscribe('telegram.sent', (evt) => {
      dashboardBridge!.broadcast({
        type: 'telegram_sent',
        text: (evt.payload as any)?.text ?? '',
        ts: evt.ts,
      });
    });
  }

  // ── Runtime control plane ───────────────────────────────────────────────
  const router = orch.getRouter();
  if (router && cfg.CONTROL_PORT > 0) {
    const redis = getRedisClient(cfg.REDIS_URL);
    const authToken = cfg.CONTROL_AUTH_TOKEN?.trim();
    // Live mode REQUIRES a control token. Anything reachable on localhost
    // (sidecars, kubectl port-forward, shared shells) can otherwise curl
    // /runtime/kill or hot-swap the adapter mid-trade. Refuse to start.
    if (cfg.EXECUTION_MODE === 'live' && !authToken) {
      throw new Error(
        'CONTROL_AUTH_TOKEN is required when EXECUTION_MODE=live and CONTROL_PORT>0. ' +
        'Set it to a long random string (≥16 chars) in your environment, or disable the ' +
        'control plane with CONTROL_PORT=0.',
      );
    }
    controlServer = new ControlHttpServer(redis, router, () => orch!.hasPosition(), {
      authToken,
      log,
    });

    // Subscribe to Redis pub/sub config changes (separate connection required for sub mode).
    if (cfg.REDIS_URL) {
      const redisSub = new Redis(cfg.REDIS_URL, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 3,
      });
      redisSub.on('error', (err: Error) => {
        process.stderr.write(`redis_sub_error ${(err as Error).message}\n`);
      });
      controlServer.watchRedisConfigChanges(redisSub);
    }

    lifecycle.register('control_http', () => controlServer!.stop(), { timeoutMs: 3000 });
    lifecycle.register('redis', () => closeRedisClient(), { timeoutMs: 2000 });
  }

  try {
    // Bind the dashboard HTTP/WS server FIRST so vite proxy stops spamming
    // ECONNREFUSED while orch.start() does its REST history backfill (which
    // can take 10-30s for 2000 bars × N symbols × N timeframes).
    if (dashboardBridge) {
      await dashboardBridge.listen();
    }
    if (controlServer) {
      await controlServer.listen(cfg.CONTROL_PORT);
      log.info('control_server_started', { port: cfg.CONTROL_PORT });
    }
    await orch.start();
  } catch (err) {
    log.warn('startup_failed', { err: (err as Error).message });
    await lifecycle.shutdown('startup_error');
    orch = null;
    dashboardBridge = null;
    process.exit(1);
  }
}

main().catch(async (err) => {
  process.stderr.write(String(err instanceof Error ? err.stack ?? err.message : err) + '\n');
  if (controlServer) {
    try { await controlServer.stop(); } catch { /* ignore */ }
    controlServer = null;
  }
  if (dashboardBridge) {
    try { await dashboardBridge.stop(); } catch { /* ignore */ }
    dashboardBridge = null;
  }
  if (orch) {
    try { orch.stop(); } catch { /* ignore */ }
    orch = null;
  }
  await closeRedisClient();
  process.exit(1);
});
