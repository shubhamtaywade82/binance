import type { AppConfig } from '../../config';
import type { ExecutionRuntime } from '../../execution/create-runtime';
import {
  getPositionRisk,
  getOpenAlgoOrders,
  getPositionSideDual,
} from '../../binance/rest-trade';

export interface ReconciledPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
}

export type ReconciliationSource = 'paper' | 'coindcx' | 'binance' | 'none';

export interface ReconciliationResult {
  source: ReconciliationSource;
  positions: ReconciledPosition[];
  /** Non-empty when soft-mode reconciliation hit an error but caller chose not to throw. */
  errors: string[];
}

export interface ReconciliationLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ReconciliationOptions {
  /**
   * When true (default in live mode), a failure to reach the exchange THROWS.
   * The bot refuses to start rather than trade against an unknown account.
   * Set to false in tests or when intentionally booting without exchange access.
   */
  strict?: boolean;
}

/**
 * Reconcile internal state with exchange truth at boot.
 *
 * MUST be called before any strategy / bridge wiring so that the RiskEngine,
 * exit managers, and position-tracking subsystems start with a correct view
 * of open exposure. Without this step, a restart while a live position is
 * open lets opposite-side signals bypass `OPPOSITE_SIDE_OPEN_POSITION` and
 * the bot can double its exposure on the very first kline close.
 *
 *   paper    → read the local PaperExecutionAdapter (wallet.json reload happens
 *              earlier in createExecutionRuntime).
 *   coindcx  → query `getFuturesPositions()`; throw on transport failure (strict).
 *   binance  → query `positionRisk` + `openAlgoOrders` per multiplex symbol and
 *              call `adapter.restoreFromExchange` so cancel-on-close still works.
 */
export const reconcilePositionsAtStartup = async (
  execution: ExecutionRuntime,
  cfg: AppConfig,
  symbols: string[],
  log: ReconciliationLogger,
  opts: ReconciliationOptions = {},
): Promise<ReconciliationResult> => {
  const strict = opts.strict ?? cfg.EXECUTION_MODE === 'live';
  const errors: string[] = [];

  // Paper: trust the local adapter (wallet.json was already loaded).
  if (execution.paperAdapter) {
    const open = execution.paperAdapter.getOpenPositions();
    return {
      source: 'paper',
      positions: open.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        quantity: p.quantity,
        entryPrice: p.entryPrice,
      })),
      errors: [],
    };
  }

  // Live CoinDCX: query the exchange's position list.
  if (execution.cdcxAdapter) {
    try {
      const open = await execution.cdcxAdapter.getOpenPositions();
      const positions: ReconciledPosition[] = (open ?? [])
        .filter((p: any) => {
          const qty = Number(p.quantity);
          return Number.isFinite(qty) && qty > 0;
        })
        .map((p: any) => ({
          symbol: String(p.symbol),
          side: (p.side === 'LONG' || p.side === 'SHORT') ? p.side : 'LONG',
          quantity: Number(p.quantity),
          entryPrice: Number(p.entryPrice),
        }));
      log.info('reconciliation_coindcx_done', {
        positions: positions.length,
        symbols: positions.map((p) => p.symbol),
      });
      return { source: 'coindcx', positions, errors };
    } catch (err) {
      const msg = (err as Error).message || 'unknown';
      errors.push(msg);
      log.warn('reconciliation_coindcx_failed', { err: msg });
      if (strict) {
        throw new Error(`startup_reconciliation_failed:coindcx:${msg}`);
      }
      return { source: 'coindcx', positions: [], errors };
    }
  }

  // Live Binance: per-symbol positionRisk + openAlgoOrders. The Binance live
  // adapter has a restoreFromExchange method that re-attaches algo strategyIds
  // so cancel-on-close works after a crash.
  if (execution.binanceAdapter && execution.binanceRestClient) {
    const adapter = execution.binanceAdapter;
    const client = execution.binanceRestClient;
    const positions: ReconciledPosition[] = [];

    // Detect hedge mode once so the adapter tags follow-up orders correctly.
    try {
      const dual = await getPositionSideDual(client);
      adapter.setHedgeMode(Boolean((dual as any)?.dualSidePosition));
    } catch (err) {
      const msg = (err as Error).message || 'unknown';
      errors.push(`positionSide/dual:${msg}`);
      log.warn('reconciliation_binance_hedge_mode_failed', { err: msg });
      if (strict) {
        throw new Error(`startup_reconciliation_failed:binance:positionSide/dual:${msg}`);
      }
    }

    const targets = symbols.length > 0 ? symbols : [cfg.BINANCE_SYMBOL.trim().toUpperCase()];
    for (const sym of targets) {
      try {
        const [rows, algoRows] = await Promise.all([
          getPositionRisk(client, sym),
          getOpenAlgoOrders(client, sym),
        ]);
        for (const pos of rows ?? []) {
          const amt = Number(pos.positionAmt);
          if (!Number.isFinite(amt) || amt === 0) continue;
          const internalId = adapter.restoreFromExchange(pos, algoRows ?? []);
          if (!internalId) continue;
          positions.push({
            symbol: pos.symbol.toUpperCase(),
            side: amt > 0 ? 'LONG' : 'SHORT',
            quantity: Math.abs(amt),
            entryPrice: Number(pos.entryPrice),
          });
        }
      } catch (err) {
        const msg = (err as Error).message || 'unknown';
        errors.push(`${sym}:${msg}`);
        log.warn('reconciliation_binance_symbol_failed', { symbol: sym, err: msg });
        if (strict) {
          throw new Error(`startup_reconciliation_failed:binance:${sym}:${msg}`);
        }
      }
    }
    log.info('reconciliation_binance_done', {
      positions: positions.length,
      symbols: positions.map((p) => p.symbol),
      errors: errors.length,
    });
    return { source: 'binance', positions, errors };
  }

  // Nothing to reconcile (e.g. signals-only test harness).
  log.info('reconciliation_skipped_no_live_adapter', {});
  return { source: 'none', positions: [], errors };
};
