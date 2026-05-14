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

export interface ExecutionRuntime {
  /** The active execution adapter — always an ExecutionRouter in production. */
  adapter: ExecutionAdapter;
  book: BookTickerFeed;
  /** REST client for Binance trading API (set when BINANCE_EXECUTION_ADAPTER=true). */
  binanceRestClient?: BinanceRestClient;
  stopFunding?: () => void;
  /** Router wrapper for hot-swapping exchange/env at runtime. Present in all production paths;
   *  absent only in unit tests that inject a minimal stub adapter directly. */
  router?: ExecutionRouter;
}

const symbolFromPair = (cfg: AppConfig, _pair: string): string => {
  return cfg.BINANCE_SYMBOL.trim().toUpperCase();
}

export const createExecutionRuntime = (cfg: AppConfig, cdcx: CoinDcxFuturesClient): ExecutionRuntime => {
  const book = new BookTickerFeed({
    wsBase: binanceWsBase(cfg),
    symbols: [cfg.BINANCE_SYMBOL.trim().toUpperCase()],
    product: cfg.BINANCE_PRODUCT,
  });

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

      // Require explicit opt-in before sending real orders to mainnet.
      if (!cfg.BINANCE_FUTURES_TESTNET && !cfg.CONFIRMED_LIVE_TRADING) {
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
      return { adapter: router, book, binanceRestClient, router };
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
    return { adapter: cdcxRouter, book, router: cdcxRouter };
  }

  // ── Paper adapter ─────────────────────────────────────────────────────
  const ledgerDir = cfg.PAPER_LEDGER_DIR.trim() || './paper';
  const walletPath = path.join(ledgerDir, 'wallet.json');
  const wallet = new PaperWallet(cfg.PAPER_INITIAL_BALANCE_USDT, walletPath);
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
  });
  const paperRouter = new ExecutionRouter(cfg, cdcx, paperAdapter);

  return {
    adapter: paperRouter,
    book,
    router: paperRouter,
    stopFunding: () => funding.stop(),
  };
}
