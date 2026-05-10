import path from 'node:path';
import { binanceRestBase, type AppConfig } from '../config';
import type { CoinDcxFuturesClient } from '../coindcx/futures-client';
import { CoinDcxExecutionAdapter } from './coindcx-adapter';
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
  stopFunding?: () => void;
}

function symbolFromPair(cfg: AppConfig, _pair: string): string {
  return cfg.BINANCE_SYMBOL.trim().toUpperCase();
}

/**
 * Live: CoinDCX REST adapter. Paper: simulated fills + ledger (book fed synthetically from marks).
 */
export function createExecutionRuntime(cfg: AppConfig, cdcx: CoinDcxFuturesClient): ExecutionRuntime {
  const book = new BookTickerFeed({
    wsBase: binanceRestBase(cfg),
    symbols: [cfg.BINANCE_SYMBOL.trim().toUpperCase()],
  });

  if (cfg.EXECUTION_MODE === 'live') {
    if (cfg.READ_ONLY) {
      throw new Error('EXECUTION_MODE=live but READ_ONLY=true. Set READ_ONLY=false to enable live execution.');
    }
    if (!cfg.COINDCX_API_KEY.trim() || !cfg.COINDCX_API_SECRET.trim()) {
      throw new Error('EXECUTION_MODE=live requires COINDCX_API_KEY and COINDCX_API_SECRET.');
    }
    const adapter = new CoinDcxExecutionAdapter({
      client: cdcx,
      marginCurrency: cfg.MARGIN_CURRENCY,
      takerFee: cfg.TAKER_FEE,
      fundingFeeEst: cfg.FUNDING_FEE_EST,
    });
    return { adapter, book };
  }

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
