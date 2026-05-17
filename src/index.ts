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
import { FundingExitManager } from './core/execution/funding-exit-manager';
import { TpLadderManager } from './core/execution/tp-ladder-manager';
import { PositionCloseBridge } from './core/execution/position-close-bridge';
import { EventToPostgresBridge } from './core/persistence/event-to-postgres-bridge';
import { LiveAccountPoller } from './core/execution/live-account-poller';
import { CoinDcxUserDataWs } from './coindcx/user-data-ws';
import { MarkPriceBridge } from './core/execution/mark-price-bridge';
import { SignalAllocator } from './core/execution/signal-allocator';
import type { DomainEvent } from '@coindcx/contracts';

let orch: HybridOrchestrator | null = null;
let actorSystem: ActorSystem | null = null;
let dashboardBridge: DashboardBridge | null = null;
let controlServer: ControlHttpServer | null = null;

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
  if (execution.pgWriter) {
    const eventStore = new EventStore(execution.pgWriter, defaultEventBus);
    eventStore.startRecording();
  }

  actorSystem = new ActorSystem(cfg, defaultEventBus);
  const allSymbols = multiplexBinanceSymbols(cfg);
  for (const sym of allSymbols) {
    actorSystem.spawnSymbolActor(sym);
  }

  // Restart safety: PaperWallet survives via wallet.json but RiskEngine
  // exposure is in-memory only. Without seeding, a restart while in-position
  // would let opposite-side signals bypass OPPOSITE_SIDE_OPEN_POSITION and
  // the adapter would record REVERSAL trades.
  if (execution.paperAdapter) {
    const open = execution.paperAdapter.getOpenPositions();
    if (open.length > 0) {
      actorSystem.getRiskEngine().seedPositions(
        open.map((p) => ({ symbol: p.symbol, side: p.side, quantity: p.quantity, entryPrice: p.entryPrice })),
      );
      log.info('risk_engine_seeded', { positions: open.length });
    }
  }

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
      new ExecutionBridge(cfg, defaultEventBus, adapter);
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
        });

        if ((cfg as any).STRUCTURE_EXIT_ENABLED) {
          new StructureExitManager(defaultEventBus, {
            swingLookback: Number((cfg as any).STRUCTURE_SWING_LOOKBACK) || 5,
            bufferBars: Math.max(60, Number((cfg as any).STRUCTURE_SWING_LOOKBACK) * 12),
          });
        }
        if ((cfg as any).TIME_STOP_ENABLED) {
          new TimeStopManager(defaultEventBus, {
            barsThreshold: Number((cfg as any).TIME_STOP_BARS) || 24,
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
          timeStop: Boolean((cfg as any).TIME_STOP_ENABLED),
          fundingExit: Boolean((cfg as any).FUNDING_EXIT_ENABLED),
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
    dashboardBridge = createDashboardBridge(cfg, log, {
      store,
      orderbook,
      tradeTape,
      marketFeeds,
      orderBookSnapshotRing,
      precisionBySymbol,
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
    });

    const activeAdapter = execution.paperAdapter || execution.cdcxAdapter || execution.adapter;
    if (activeAdapter.setOnTradeClose) {
      activeAdapter.setOnTradeClose((trade) => dashboardBridge!.broadcastPaperTrade(trade));
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
  }

  // ── Runtime control plane ───────────────────────────────────────────────
  const router = orch.getRouter();
  if (router && cfg.CONTROL_PORT > 0) {
    const redis = getRedisClient(cfg.REDIS_URL);
    controlServer = new ControlHttpServer(redis, router, () => orch!.hasPosition());

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
