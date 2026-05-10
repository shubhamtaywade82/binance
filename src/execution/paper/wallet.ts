import fs from 'fs';
import path from 'path';

export interface WalletState {
  balanceUsdt: number;
  availableUsdt: number;
  usedMarginUsdt: number;
  unrealizedPnlUsdt: number;
  realizedPnlUsdt: number;
  equityUsdt: number;
  updatedAt: number;
}

export class PaperWallet {
  private balanceUsdt: number;
  private usedMarginUsdt = 0;
  private unrealizedPnlUsdt = 0;
  private realizedPnlUsdt = 0;
  private updatedAt = Date.now();

  constructor(initialUsdt: number, private readonly persistPath?: string) {
    this.balanceUsdt = initialUsdt;
  }

  state(): WalletState {
    const availableUsdt = this.balanceUsdt - this.usedMarginUsdt;
    const equityUsdt = this.balanceUsdt + this.unrealizedPnlUsdt;
    return {
      balanceUsdt: this.balanceUsdt,
      availableUsdt,
      usedMarginUsdt: this.usedMarginUsdt,
      unrealizedPnlUsdt: this.unrealizedPnlUsdt,
      realizedPnlUsdt: this.realizedPnlUsdt,
      equityUsdt,
      updatedAt: this.updatedAt,
    };
  }

  reserveMargin(usdt: number): boolean {
    if (usdt < 0) return false;
    if (this.balanceUsdt - this.usedMarginUsdt < usdt) return false;
    this.usedMarginUsdt += usdt;
    this.touch();
    return true;
  }

  releaseMargin(usdt: number): void {
    this.usedMarginUsdt = Math.max(0, this.usedMarginUsdt - usdt);
    this.touch();
  }

  applyRealized(pnl: number): void {
    this.realizedPnlUsdt += pnl;
    this.balanceUsdt += pnl;
    this.touch();
  }

  setUnrealized(pnl: number): void {
    this.unrealizedPnlUsdt = pnl;
    this.touch();
  }

  loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = fs.readFileSync(this.persistPath, 'utf8');
      const j = JSON.parse(raw) as Partial<WalletState>;
      if (typeof j.balanceUsdt === 'number') this.balanceUsdt = j.balanceUsdt;
      if (typeof j.usedMarginUsdt === 'number') this.usedMarginUsdt = j.usedMarginUsdt;
      if (typeof j.realizedPnlUsdt === 'number') this.realizedPnlUsdt = j.realizedPnlUsdt;
      if (typeof j.unrealizedPnlUsdt === 'number') this.unrealizedPnlUsdt = j.unrealizedPnlUsdt;
      this.touch();
    } catch {
      // ignore corrupt file; keep in-memory
    }
  }

  flushToDisk(): void {
    if (!this.persistPath) return;
    const dir = path.dirname(this.persistPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.persistPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state(), null, 2));
    fs.renameSync(tmp, this.persistPath);
  }

  private touch(): void {
    this.updatedAt = Date.now();
  }
}
