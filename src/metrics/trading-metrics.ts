export interface TradingMetrics {
  realizedPnl: number;
  unrealizedPnl: number;
  equityCurve: { ts: number; equity: number }[];
  currentDrawdown: number;
  maxDrawdown: number;
  peakEquity: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpe7d: number;
  sharpe30d: number;
}

const MAX_EQUITY_POINTS = 1000;
const ANNUALIZATION_FACTOR = Math.sqrt(365);

export class TradingMetricsTracker {
  private realizedPnl = 0;
  private unrealizedPnl = 0;
  private peakEquity: number;
  private maxDrawdown = 0;
  private currentEquity: number;

  private totalTrades = 0;
  private winningTrades = 0;
  private losingTrades = 0;
  private totalWinAmount = 0;
  private totalLossAmount = 0;

  private readonly equityCurve: { ts: number; equity: number }[] = [];
  private readonly dailyReturns: number[] = [];
  private readonly maxDailyReturns: number;

  constructor(initialEquity = 0) {
    this.currentEquity = initialEquity;
    this.peakEquity = initialEquity;
    this.maxDailyReturns = 365;
  }

  recordTrade(pnl: number): void {
    this.realizedPnl += pnl;
    this.totalTrades++;

    if (pnl > 0) {
      this.winningTrades++;
      this.totalWinAmount += pnl;
    } else if (pnl < 0) {
      this.losingTrades++;
      this.totalLossAmount += Math.abs(pnl);
    }
  }

  updateUnrealizedPnl(unrealized: number): void {
    this.unrealizedPnl = unrealized;
  }

  updateEquity(equity: number): void {
    this.currentEquity = equity;

    if (equity > this.peakEquity) {
      this.peakEquity = equity;
    }

    const dd = this.peakEquity > 0
      ? (equity - this.peakEquity) / this.peakEquity
      : 0;
    if (dd < this.maxDrawdown) {
      this.maxDrawdown = dd;
    }

    this.equityCurve.push({ ts: Date.now(), equity });
    if (this.equityCurve.length > MAX_EQUITY_POINTS) {
      this.equityCurve.shift();
    }
  }

  recordDailyReturn(ret: number): void {
    this.dailyReturns.push(ret);
    if (this.dailyReturns.length > this.maxDailyReturns) {
      this.dailyReturns.shift();
    }
  }

  snapshot(): TradingMetrics {
    const avgWin = this.winningTrades > 0 ? this.totalWinAmount / this.winningTrades : 0;
    const avgLoss = this.losingTrades > 0 ? this.totalLossAmount / this.losingTrades : 0;

    const currentDrawdown = this.peakEquity > 0
      ? (this.currentEquity - this.peakEquity) / this.peakEquity
      : 0;

    return {
      realizedPnl: this.realizedPnl,
      unrealizedPnl: this.unrealizedPnl,
      equityCurve: [...this.equityCurve],
      currentDrawdown,
      maxDrawdown: this.maxDrawdown,
      peakEquity: this.peakEquity,
      totalTrades: this.totalTrades,
      winningTrades: this.winningTrades,
      losingTrades: this.losingTrades,
      winRate: this.totalTrades > 0 ? this.winningTrades / this.totalTrades : 0,
      avgWin,
      avgLoss,
      profitFactor: avgLoss > 0 ? avgWin / avgLoss : 0,
      sharpe7d: this.computeSharpe(7),
      sharpe30d: this.computeSharpe(30),
    };
  }

  private computeSharpe(days: number): number {
    const window = this.dailyReturns.slice(-days);
    if (window.length < 2) return 0;

    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    let sumSq = 0;
    for (const r of window) sumSq += (r - mean) ** 2;
    const std = Math.sqrt(sumSq / (window.length - 1));
    if (std === 0) return 0;

    return (mean / std) * ANNUALIZATION_FACTOR;
  }
}
