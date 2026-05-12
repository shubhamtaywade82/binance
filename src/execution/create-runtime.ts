import path from 'node:path';
import { binanceRestBase, binanceWsBase, type AppConfig } from '../config';
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

export interface ExecutionRuntime {
  adapter: ExecutionAdapter;
  book: BookTickerFeed;
  /** REST client for Binance trading API (set when BINANCE_EXECUTION_ADAPTER=true). */
  binanceRestClient?: BinanceRestClient;
  stopFunding?: () => void;
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
      if (!cfg.BINANCE_API_KEY.trim() || !cfg.BINANCE_API_SECRET.trim()) {
        throw new Error(
          'BINANCE_EXECUTION_ADAPTER=true requires BINANCE_API_KEY and BINANCE_API_SECRET.',
        );
      }
      const binanceRestClient = new BinanceRestClient({
        apiKey: cfg.BINANCE_API_KEY.trim(),
        apiSecret: cfg.BINANCE_API_SECRET.trim(),
        baseUrl: binanceRestBase(cfg),
      });
      const adapter = new BinanceLiveExecutionAdapter({
        client: binanceRestClient,
        symbol: cfg.BINANCE_SYMBOL.trim().toUpperCase(),
        takerFee: cfg.TAKER_FEE,
        fundingFeeEst: cfg.FUNDING_FEE_EST,
        marginType: 'ISOLATED',
      });
      return { adapter, book, binanceRestClient };
    }

    // ── CoinDCX live adapter (legacy) ─────────────────────────────────────
    if (!cfg.COINDCX_API_KEY.trim() || !cfg.COINDCX_API_SECRET.trim()) {
      throw new Error('EXECUTION_MODE=live requires COINDCX_API_KEY and COINDCX_API_SECRET (or set BINANCE_EXECUTION_ADAPTER=true).');
    }
    const adapter = new CoinDcxExecutionAdapter({
      client: cdcx,
      marginCurrency: cfg.MARGIN_CURRENCY,
      takerFee: cfg.TAKER_FEE,
      fundingFeeEst: cfg.FUNDING_FEE_EST,
    });
    return { adapter, book };
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

  const adapter = new PaperExecutionAdapter({
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

  return {
    adapter,
    book,
    stopFunding: () => funding.stop(),
  };
}
