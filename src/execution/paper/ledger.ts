import fs from 'fs';
import path from 'path';
import type { ClosedPosition } from '../types';
import type { WalletState } from './wallet';

export interface OpenSnapshot {
  orderId: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  unrealizedUsdt: number;
}

export class Ledger {
  private readonly tradesPath: string;
  private readonly equityPath: string;
  private readonly walletPath: string;

  constructor(dir: string) {
    this.tradesPath = path.join(dir, 'trades.jsonl');
    this.equityPath = path.join(dir, 'equity.jsonl');
    this.walletPath = path.join(dir, 'wallet.json');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  get walletFilePath(): string {
    return this.walletPath;
  }

  appendTrade(p: ClosedPosition): void {
    fs.appendFileSync(this.tradesPath, JSON.stringify(p) + '\n');
  }

  snapshotEquity(state: WalletState, openPositions: OpenSnapshot[]): void {
    const row = {
      ts: Date.now(),
      ...state,
      openPositions,
    };
    fs.appendFileSync(this.equityPath, JSON.stringify(row) + '\n');
  }
}
