import type { InstrumentPrecision } from '../mapping/precision';
import type { AppConfig } from '../config';
import type { CoinDcxFuturesClient } from '../coindcx/futures-client';
import { BinanceRestClient } from '../binance/rest-client';
import { BinanceLiveExecutionAdapter } from './binance-adapter';
import { CoinDcxExecutionAdapter } from './coindcx-adapter';
import type { ExecutionAdapter, ExecutionMode, OrderRequest, OrderResult, ClosedPosition, CloseReason } from './types';
import type { RuntimeConfig } from '../services/runtime-config';

export interface SwitchResult {
  ok: boolean;
  error?: string;
  previous?: { exchange: string; env: string };
  current?: { exchange: string; env: string };
}

/**
 * Wraps any ExecutionAdapter and allows atomic hot-swapping at runtime.
 *
 * The adapter swap is synchronous (single JS assignment) so there is no
 * window where a call can land on a half-initialised adapter.
 *
 * Safety invariants:
 *  - Refuses to switch while a position is open (caller must pass hasPosition).
 *  - Refuses to switch to mainnet when CONFIRMED_LIVE_TRADING is false.
 *  - Refuses to switch while another switch is in progress (lock flag).
 */
export class ExecutionRouter implements ExecutionAdapter {
  private current: ExecutionAdapter;
  private activeEnv: RuntimeConfig['env'];
  private activeExchange: RuntimeConfig['exchange'];
  private switching = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly cdcx: CoinDcxFuturesClient,
    initial: ExecutionAdapter,
  ) {
    this.current = initial;
    this.activeEnv      = cfg.BINANCE_FUTURES_TESTNET ? 'testnet' : 'mainnet';
    this.activeExchange = cfg.BINANCE_EXECUTION_ADAPTER ? 'binance' : 'coindcx';
  }

  /** Proxied so position-manager log events still show 'live_open' vs 'paper_open'. */
  get name(): ExecutionMode { return this.current.name; }

  // ─── ExecutionAdapter proxy ───────────────────────────────────────────────

  placeOrder(req: OrderRequest): Promise<OrderResult> {
    return this.current.placeOrder(req);
  }

  closePosition(orderId: string, reason: CloseReason): Promise<ClosedPosition> {
    return this.current.closePosition(orderId, reason);
  }

  onMark(symbol: string, markPrice: number): void {
    this.current.onMark?.(symbol, markPrice);
  }

  setLeverage(pair: string, lev: number): Promise<void> {
    return this.current.setLeverage?.(pair, lev) ?? Promise.resolve();
  }

  /** Live Binance adapter when the router is on Binance; otherwise null. */
  getBinanceLiveAdapter(): BinanceLiveExecutionAdapter | null {
    return this.current instanceof BinanceLiveExecutionAdapter ? this.current : null;
  }

  setPrecisionForBinance(p: InstrumentPrecision): void {
    this.getBinanceLiveAdapter()?.setPrecision(p);
  }

  applyBinanceHedgeMode(dualSidePosition: boolean): void {
    this.getBinanceLiveAdapter()?.setHedgeMode(dualSidePosition);
  }

  // ─── Runtime switching ────────────────────────────────────────────────────

  currentConfig(): RuntimeConfig {
    return { env: this.activeEnv, exchange: this.activeExchange };
  }

  /**
   * Attempt to swap to a new adapter configuration.
   *
   * @param rc         Target environment + exchange.
   * @param hasPosition Returns true when a position is currently open.
   *                    The switch is rejected until the position is closed.
   */
  applyConfig(rc: RuntimeConfig, hasPosition: () => boolean): SwitchResult {
    const previous = { exchange: this.activeExchange, env: this.activeEnv };

    // No-op: already running with this config.
    if (rc.env === this.activeEnv && rc.exchange === this.activeExchange) {
      return { ok: true, current: previous };
    }

    // Block concurrent switch attempts.
    if (this.switching) {
      return { ok: false, error: 'A switch is already in progress.' };
    }

    // Safety: open position must be closed first.
    if (hasPosition()) {
      return {
        ok: false,
        error: 'Cannot switch execution while a position is open. Close all positions first.',
      };
    }

    // Safety: mainnet requires explicit opt-in.
    if (rc.env === 'mainnet' && !this.cfg.CONFIRMED_LIVE_TRADING) {
      return {
        ok: false,
        error: 'CONFIRMED_LIVE_TRADING must be true in .env before switching to mainnet.',
      };
    }

    this.switching = true;
    try {
      this.current        = this.buildAdapter(rc);
      this.activeEnv      = rc.env;
      this.activeExchange = rc.exchange;
      return { ok: true, previous, current: { exchange: rc.exchange, env: rc.env } };
    } finally {
      this.switching = false;
    }
  }

  private buildAdapter(rc: RuntimeConfig): ExecutionAdapter {
    if (rc.exchange === 'binance') {
      const useTestnet = rc.env === 'testnet';
      const { apiKey, apiSecret } = useTestnet
        ? { apiKey: this.cfg.BINANCE_TESTNET_API_KEY.trim(), apiSecret: this.cfg.BINANCE_TESTNET_API_SECRET.trim() }
        : { apiKey: this.cfg.BINANCE_API_KEY.trim(),         apiSecret: this.cfg.BINANCE_API_SECRET.trim() };

      if (!apiKey || !apiSecret) {
        throw new Error(
          useTestnet
            ? 'BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET not set.'
            : 'BINANCE_API_KEY / BINANCE_API_SECRET not set.',
        );
      }

      const baseUrl = useTestnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com';

      const client = new BinanceRestClient({ apiKey, apiSecret, baseUrl });
      return new BinanceLiveExecutionAdapter({
        client,
        symbol:        this.cfg.BINANCE_SYMBOL.trim().toUpperCase(),
        takerFee:      this.cfg.TAKER_FEE,
        fundingFeeEst: this.cfg.FUNDING_FEE_EST,
        marginType:    'ISOLATED',
      });
    }

    // CoinDCX
    return new CoinDcxExecutionAdapter({
      client:        this.cdcx,
      marginCurrency: this.cfg.MARGIN_CURRENCY,
      takerFee:      this.cfg.TAKER_FEE,
      fundingFeeEst: this.cfg.FUNDING_FEE_EST,
    });
  }
}
