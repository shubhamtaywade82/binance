import type { BinanceRestClient } from '../binance/rest-client';
import { getIncomeHistory, type IncomeRow } from '../binance/rest-trade';

export interface ReconciliationResult {
  exchangePnl: number;
  localPnl: number;
  discrepancy: number;
  count: number;
}

export class IncomeReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private localRealizedPnl = 0;
  private lastSyncTime = 0;

  constructor(
    private readonly client: BinanceRestClient,
    private readonly symbol: string,
    private readonly intervalMs: number,
    private readonly onDiscrepancy?: (result: ReconciliationResult) => void,
    private readonly threshold = 0.01,
  ) {}

  addLocalPnl(netUsdt: number): void {
    this.localRealizedPnl += netUsdt;
  }

  start(): void {
    if (this.timer) return;
    this.lastSyncTime = Date.now() - 24 * 60 * 60 * 1000;
    this.timer = setInterval(() => void this.reconcile(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async reconcile(): Promise<ReconciliationResult> {
    const rows: IncomeRow[] = await getIncomeHistory(this.client, {
      symbol: this.symbol,
      incomeType: 'REALIZED_PNL',
      startTime: this.lastSyncTime,
    });
    this.lastSyncTime = Date.now();

    const exchangePnl = rows.reduce((sum, r) => sum + parseFloat(r.income), 0);
    const discrepancy = Math.abs(exchangePnl - this.localRealizedPnl);

    const result: ReconciliationResult = {
      exchangePnl,
      localPnl: this.localRealizedPnl,
      discrepancy,
      count: rows.length,
    };

    if (discrepancy > this.threshold) {
      this.onDiscrepancy?.(result);
    }

    return result;
  }

  reset(): void {
    this.localRealizedPnl = 0;
    this.lastSyncTime = Date.now() - 24 * 60 * 60 * 1000;
  }
}
