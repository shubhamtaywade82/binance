import path from 'node:path';
import { binanceApiCredentials, binanceRestBase, binanceWsBase, type AppConfig } from '../config';
import type { CoinDcxFuturesClient } from '../coindcx/futures-client';
import { CoinDcxExecutionAdapter } from './coindcx-adapter';
import { BinanceLiveExecutionAdapter } from './binance-adapter';
import { BinanceRestClient } from '../binance/rest-client';
import type { ExecutionAdapter } from './types';
import { BookTickerFeed } from './paper/book-ticker-feed';
import { PaperExecutionAdapter } from './paper/adapter';
import { PaperWallet } from './paper/wallet';
import { Ledger } from './paper/ledger';
import { LiquidationEngine } from './paper/liquidation';
import { FundingEngine } from './paper/funding';
import { ExecutionRouter } from './execution-router';
import { PgWriter } from '../persistence/pg-writer';

export interface ExecutionRuntime {
  /** The active execution adapter — always an ExecutionRouter in production. */
  adapter: ExecutionAdapter;
  book: BookTickerFeed;
  /** REST client for Binance trading API (set when BINANCE_EXECUTION_ADAPTER=true). */
  binanceRestClient?: BinanceRestClient;
  stopFunding?: () => void;
  stopPgWriter?: () => Promise<void>;
  /** Router wrapper for hot-swapping exchange/env at runtime. Present in all production paths;
   *  absent only in unit tests that inject a minimal stub adapter directly. */
  router?: ExecutionRouter;
  /** Present only when EXECUTION_MODE=paper. */
  paperAdapter?: PaperExecutionAdapter;
  /** Shared database writer for dashboard persistence. */
  pgWriter?: PgWriter;
}

/**
 * Map an OrderRequest.pair → Binance USD-M symbol.
 *  · Event-bus path passes `pair = 'ETHUSDT'` directly → upper-case + return.
 *  · CoinDCX legacy path passes `pair = 'B-SOL_USDT'` → strip 'B-' + '_'.
 *  · Empty / unknown → fall back to BINANCE_SYMBOL.
 *
 * Pre-fix this returned BINANCE_SYMBOL unconditionally, which collapsed every
 * multi-symbol paper fill onto the SOL book ticker (everyone got SOL's price).
 */
const symbolFromPair = (cfg: AppConfig, pair: string): string => {
  const raw = (pair ?? '').trim();
  if (!raw) return cfg.BINANCE_SYMBOL.trim().toUpperCase();
  // CoinDCX style: B-SOL_USDT → SOLUSDT
  if (raw.includes('-') || raw.includes('_')) {
    const stripped = raw.replace(/^B-/i, '').replace('_', '').toUpperCase();
    return stripped || cfg.BINANCE_SYMBOL.trim().toUpperCase();
  }
  // Already a Binance-style symbol
  return raw.toUpperCase();
};

export const createExecutionRuntime = (cfg: AppConfig, cdcx: CoinDcxFuturesClient): ExecutionRuntime => {
  // Subscribe book ticker for the entire multiplex watchlist (not only
  // BINANCE_SYMBOL) so multi-symbol paper fills get realistic bid/ask data
  // instead of falling back to the kline close + flat slippage.
  const bookSymbols = Array.from(
    new Set(
      [cfg.BINANCE_SYMBOL, ...(cfg.BINANCE_WATCHLIST ?? [])]
        .map((s) => (s ?? '').trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  const book = new BookTickerFeed({
    wsBase: binanceWsBase(cfg),
    symbols: bookSymbols,
    product: cfg.BINANCE_PRODUCT,
  });

  let pgWriter: PgWriter | undefined;
  if (cfg.POSTGRES_URL) {
    pgWriter = new PgWriter({ connectionString: cfg.POSTGRES_URL });
    pgWriter.connect().catch(() => {});
  }

  if (cfg.EXECUTION_MODE === 'live') {
    if (cfg.READ_ONLY) {
      throw new Error('EXECUTION_MODE=live but READ_ONLY=true. Set READ_ONLY=false to enable live execution.');
    }

    // ── Binance live adapter ──────────────────────────────────────────────
    if (cfg.BINANCE_EXECUTION_ADAPTER) {
      const { apiKey, apiSecret } = binanceApiCredentials(cfg);

      if (!apiKey || !apiSecret) {
        const keyVar = cfg.BINANCE_FUTURES_TESTNET ? 'BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET' : 'BINANCE_API_KEY / BINANCE_API_SECRET';
        throw new Error(`BINANCE_EXECUTION_ADAPTER=true requires ${keyVar}.`);
      }

      // Require explicit opt-in before sending real orders to mainnet (not demo-fapi).
      const isLiveMainnetUsdm = cfg.BINANCE_PRODUCT === 'usdm' && !cfg.BINANCE_FUTURES_TESTNET;
      if (isLiveMainnetUsdm && !cfg.CONFIRMED_LIVE_TRADING) {
        throw new Error(
          'CONFIRMED_LIVE_TRADING must be set to true to enable live trading on mainnet. ' +
          'This guard prevents accidental real-money orders.',
        );
      }

      const binanceRestClient = new BinanceRestClient({
        apiKey,
        apiSecret,
        baseUrl: binanceRestBase(cfg),
        retry: {
          maxAttempts: cfg.BINANCE_REST_RETRY_MAX_ATTEMPTS,
          baseDelayMs: cfg.BINANCE_REST_RETRY_BASE_MS,
          maxDelayMs: cfg.BINANCE_REST_RETRY_MAX_MS,
        },
      });
      const liveAdapter = new BinanceLiveExecutionAdapter({
        client: binanceRestClient,
        symbol: cfg.BINANCE_SYMBOL.trim().toUpperCase(),
        takerFee: cfg.TAKER_FEE,
        fundingFeeEst: cfg.FUNDING_FEE_EST,
        marginType: 'ISOLATED',
      });
      const router = new ExecutionRouter(cfg, cdcx, liveAdapter);
      return {
        adapter: router,
        book,
        binanceRestClient,
        router,
        pgWriter,
        stopPgWriter: pgWriter ? () => pgWriter!.close() : undefined,
      };
    }

    // ── CoinDCX live adapter (legacy) ─────────────────────────────────────
    if (!cfg.COINDCX_API_KEY.trim() || !cfg.COINDCX_API_SECRET.trim()) {
      throw new Error('EXECUTION_MODE=live requires COINDCX_API_KEY and COINDCX_API_SECRET (or set BINANCE_EXECUTION_ADAPTER=true).');
    }
    const cdcxAdapter = new CoinDcxExecutionAdapter({
      client: cdcx,
      marginCurrency: cfg.MARGIN_CURRENCY,
      takerFee: cfg.TAKER_FEE,
      fundingFeeEst: cfg.FUNDING_FEE_EST,
    });
    const cdcxRouter = new ExecutionRouter(cfg, cdcx, cdcxAdapter);
    return {
      adapter: cdcxRouter,
      book,
      router: cdcxRouter,
      pgWriter,
      stopPgWriter: pgWriter ? () => pgWriter!.close() : undefined,
    };
  }

  // ── Paper adapter ─────────────────────────────────────────────────────
  const ledgerDir = cfg.PAPER_LEDGER_DIR.trim() || './paper';
  const walletPath = path.join(ledgerDir, 'wallet.json');
  const wallet = new PaperWallet(cfg.PAPER_INITIAL_BALANCE_USDT, walletPath);
  // Survive restarts: if ./paper/wallet.json exists, resume from its balance
  // instead of resetting to PAPER_INITIAL_BALANCE_USDT every boot.
  wallet.loadFromDisk();
  const ledger = new Ledger(ledgerDir);
  const liquidation = new LiquidationEngine(cfg.PAPER_MAINT_MARGIN);
  const funding = new FundingEngine({
    binanceRestBase: binanceRestBase(cfg),
    pollSec: cfg.PAPER_FUNDING_POLL_SEC,
  });
  funding.start();

  const paperAdapter = new PaperExecutionAdapter({
    wallet,
    book,
    liquidation,
    funding,
    ledger,
    takerFee: cfg.TAKER_FEE,
    makerFee: cfg.MAKER_FEE,
    baseSlippageBps: cfg.PAPER_BASE_SLIPPAGE_BPS,
    latencyMs: cfg.PAPER_LATENCY_MS,
    equitySnapshotMs: Math.max(1000, cfg.PAPER_EQUITY_SNAPSHOT_SEC * 1000),
    symbolFor: (pair) => symbolFromPair(cfg, pair),
    partialFills: cfg.PAPER_PARTIAL_FILLS,
    maxSlippageBps: cfg.PAPER_MAX_SLIPPAGE_BPS,
  });
  const paperRouter = new ExecutionRouter(cfg, cdcx, paperAdapter);

  return {
    adapter: paperRouter,
    book,
    router: paperRouter,
    paperAdapter,
    pgWriter,
    stopFunding: () => funding.stop(),
    stopPgWriter: pgWriter ? () => pgWriter!.close() : undefined,
  };
}
