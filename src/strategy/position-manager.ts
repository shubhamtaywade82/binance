import fs from 'fs';
import path from 'path';
import type { AppConfig } from '../config';
import type { InstrumentPrecision } from '../mapping/precision';
import type { CloseReason, Position, Side, TrendBias } from '../types';
import type { RiskManager } from './risk';
import type { ExecutionAdapter, TradeAttribution } from '../execution/types';
import type { AssetTierConfig } from '../config/asset-tiers';
import type { PgWriter } from '../persistence/pg-writer';

export interface PositionLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface CloseEvent {
  position: Position;
  exitPrice: number;
  reason: CloseReason;
  pnl: ReturnType<RiskManager['netPnl']>;
}

export type TrackedPosition = Position & {
  orderId: string;
  symbol: string;
  tier?: AssetTierConfig['tier'];
  leverage?: number;
  liqPrice?: number;
};

interface OpenLegacyArgs {
  side: Side;
  price: number;
  precision: InstrumentPrecision;
  symbol: string;
  pair: string;
  tier?: AssetTierConfig;
  attribution?: TradeAttribution;
}

const isAssetTier = (v: unknown): v is AssetTierConfig => {
  return !!v && typeof v === 'object' && 'tier' in (v as object) && 'leverage' in (v as object);
};

const isAttribution = (v: unknown): v is TradeAttribution => {
  if (!v || typeof v !== 'object') return false;
  // TradeAttribution has no required field; safest disambiguator is "not an AssetTierConfig".
  return !isAssetTier(v);
};

export class PositionManager {
  /** Keyed by uppercased symbol. */
  private readonly positions = new Map<string, TrackedPosition>();
  private readonly attributions = new Map<string, TradeAttribution | undefined>();
  /** Prevents concurrent close attempts per symbol. */
  private readonly closingInProgress = new Set<string>();
  private placeOrderDisabledLogged = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly adapter: ExecutionAdapter,
    private readonly risk: RiskManager,
    private readonly log: PositionLogger,
    private readonly pgWriter?: PgWriter,
  ) {}

  private getBaseAsset(s: string): string {
    return s.toUpperCase()
      .replace('B-', '')
      .replace('_USDT', '')
      .replace('USDT', '')
      .replace('PERP', '')
      .replace('-', '')
      .trim();
  }

  /** Legacy getter — returns *some* open position (first inserted), or null. */
  get position(): Position | null {
    const first = this.positions.values().next().value;
    return first ?? null;
  }

  hasOpenPosition(symbol?: string): boolean {
    if (!symbol) return this.positions.size > 0;
    const key = this.getBaseAsset(symbol);
    return this.positions.has(key);
  }

  getOpenPositionCount(): number {
    return this.positions.size;
  }

  getOpenSymbols(): string[] {
    return Array.from(this.positions.keys());
  }

  getOpenPositions(): TrackedPosition[] {
    return Array.from(this.positions.values());
  }

  getPosition(symbol: string): TrackedPosition | null {
    const key = this.getBaseAsset(symbol);
    return this.positions.get(key) ?? null;
  }

  /**
   * Open a new position.
   *
   * Two call shapes are accepted for backward compatibility:
   *   1. Legacy: `open(side, price, precision, pair, attribution?)`
   *      The pair is used as both the symbol key and the adapter `pair` field.
   *   2. Multi-asset: `open(side, price, precision, symbol, pair, tier?, attribution?)`
   *      `tier` (when supplied) overrides per-trade leverage/margin/TP/SL.
   */
  async open(
    side: Side,
    price: number,
    precision: InstrumentPrecision,
    symbolOrPair: string,
    pairOrAttribution?: string | TradeAttribution,
    tierOrAttribution?: AssetTierConfig | TradeAttribution,
    attribution?: TradeAttribution,
  ): Promise<Position | null> {
    const args = this.normalizeOpenArgs({
      side, price, precision, symbolOrPair, pairOrAttribution, tierOrAttribution, attribution,
    });
    return this.openInternal(args);
  }

  private normalizeOpenArgs(raw: {
    side: Side;
    price: number;
    precision: InstrumentPrecision;
    symbolOrPair: string;
    pairOrAttribution?: string | TradeAttribution;
    tierOrAttribution?: AssetTierConfig | TradeAttribution;
    attribution?: TradeAttribution;
  }): OpenLegacyArgs {
    const symbol = raw.symbolOrPair;
    let pair = symbol;
    let tier: AssetTierConfig | undefined;
    let attr: TradeAttribution | undefined;

    if (typeof raw.pairOrAttribution === 'string') {
      pair = raw.pairOrAttribution;
      if (isAssetTier(raw.tierOrAttribution)) tier = raw.tierOrAttribution;
      else if (isAttribution(raw.tierOrAttribution)) attr = raw.tierOrAttribution;
      if (raw.attribution) attr = raw.attribution;
    } else if (raw.pairOrAttribution && isAttribution(raw.pairOrAttribution)) {
      attr = raw.pairOrAttribution;
    }

    return {
      side: raw.side,
      price: raw.price,
      precision: raw.precision,
      symbol,
      pair,
      tier,
      attribution: attr,
    };
  }

  private async openInternal(args: OpenLegacyArgs): Promise<Position | null> {
    if (!this.cfg.PLACE_ORDER) {
      if (!this.placeOrderDisabledLogged) {
        this.placeOrderDisabledLogged = true;
        this.log.warn('place_order_disabled', {
          hint:
            'Set PLACE_ORDER=true for simulated (paper) or live adapter fills. Exchange REST orders only when EXECUTION_MODE=live, READ_ONLY=false, and API keys are set.',
        });
      }
      return null;
    }

    const base = this.getBaseAsset(args.symbol);
    const symbolKey = base; // Force key to be the base asset (e.g. SOL)

    // Force cleanup of any existing positions for the same base asset
    for (const [key, pos] of this.positions.entries()) {
      if (this.getBaseAsset(key) === base || pos.pair === args.pair) {
        this.log.info('open_clobber_existing', { symbol: key, newSide: args.side });
        this.positions.delete(key);
        this.pgWriter?.removePositionBySymbol(key).catch(() => {});
      }
    }

    const maxPos = this.cfg.MAX_OPEN_POSITIONS;
    if (maxPos > 0 && this.positions.size >= maxPos) {
      this.log.warn('open_rejected_max_positions', {
        symbol: symbolKey,
        openCount: this.positions.size,
        max: maxPos,
      });
      return null;
    }

    const tier = args.tier;
    const sized = this.risk.sizePosition(args.price, args.precision.stepSize, tier
      ? { leverage: tier.leverage, marginUsdt: tier.marginUsdt }
      : undefined);
    if (sized.quantity <= 0) {
      this.log.warn('open_skipped_zero_qty', { price: args.price, precision: args.precision, symbol: symbolKey });
      return null;
    }
    const { takeProfit, stopLoss } = this.risk.targets(args.price, args.side, tier
      ? { tpPct: tier.tpPct, slPct: tier.slPct }
      : undefined);
    const leverage = tier?.leverage ?? this.cfg.LEVERAGE;

    const result = await this.adapter.placeOrder({
      pair: args.pair,
      side: args.side,
      quantity: sized.quantity,
      leverage,
      marginCurrency: this.cfg.MARGIN_CURRENCY,
      referencePrice: args.price,
      takeProfit,
      stopLoss,
      tier: tier?.tier,
    });

    if (!result.ok) {
      this.log.warn('open_order_failed', { mode: this.adapter.name, error: result.error, symbol: symbolKey });
      return null;
    }

    const pos: TrackedPosition = {
      side: args.side,
      entryPrice: result.fill.price,
      quantity: sized.quantity,
      takeProfit,
      stopLoss,
      openedAt: result.fill.timestamp,
      pair: args.pair,
      notionalUsdt: sized.notionalUsdt,
      marginInr: sized.marginInr,
      orderId: result.orderId,
      symbol: symbolKey,
      tier: tier?.tier,
      leverage,
      liqPrice: result.positionId ? 0 : 0, // Placeholder for calculated liq if needed
    };
    this.positions.set(symbolKey, pos);

    this.pgWriter?.upsertPosition({
      orderId: pos.orderId,
      symbol: pos.symbol,
      side: pos.side,
      quantity: pos.quantity,
      entryPrice: pos.entryPrice,
      leverage: pos.leverage ?? 1,
      marginUsdt: pos.notionalUsdt / (pos.leverage ?? 1),
      liqPrice: 0,
      openedAt: pos.openedAt,
      tier: pos.tier,
    }).catch(() => {});
    this.pgWriter?.writeOrder({
      orderId: pos.orderId,
      symbol: pos.symbol,
      side: pos.side,
      quantity: pos.quantity,
      price: pos.entryPrice,
      status: 'FILLED',
      fillPrice: pos.entryPrice,
      feeUsdt: 0, // Fee logic is encapsulated in result, but we log fill price
    }).catch(() => {});

    this.attributions.set(symbolKey, args.attribution);
    this.log.info(this.adapter.name === 'live' ? 'live_open' : 'paper_open', {
      side: args.side, price: pos.entryPrice, qty: pos.quantity, tp: takeProfit, sl: stopLoss,
      pair: args.pair, symbol: symbolKey, tier: tier?.tier, leverage,
      orderId: result.orderId,
      ...(args.attribution ?? {}),
    });
    return pos;
  }

  /**
   * Mark a position. Two call shapes:
   *   - `onMark(symbol, price, htfTrend)`: target a specific symbol.
   *   - `onMark(price, htfTrend)`: legacy; applies to every open position
   *     using the supplied trend bias for all of them. Returns the first close.
   */
  async onMark(
    a: string | number,
    b: number | TrendBias,
    c?: TrendBias,
  ): Promise<CloseEvent | null> {
    if (typeof a === 'string') {
      const symbol = a;
      const price = b as number;
      const htfTrend = (c ?? 'NONE') as TrendBias;
      return this.onMarkForSymbol(symbol, price, htfTrend);
    }
    const price = a;
    const htfTrend = (b ?? 'NONE') as TrendBias;
    for (const sym of Array.from(this.positions.keys())) {
      const evt = await this.onMarkForSymbol(sym, price, htfTrend);
      if (evt) return evt;
    }
    return null;
  }

  private async onMarkForSymbol(symbol: string, price: number, htfTrend: TrendBias): Promise<CloseEvent | null> {
    const key = this.getBaseAsset(symbol);
    const pos = this.positions.get(key);
    if (!pos || !Number.isFinite(price)) return null;

    if (pos.side === 'LONG') {
      if (price >= pos.takeProfit) return this.close(key, price, 'TP');
      if (price <= pos.stopLoss) return this.close(key, price, 'SL');
    } else {
      if (price <= pos.takeProfit) return this.close(key, price, 'TP');
      if (price >= pos.stopLoss) return this.close(key, price, 'SL');
    }

    if (htfTrend !== 'NONE' && htfTrend !== pos.side) {
      return this.close(key, price, 'REVERSAL');
    }
    return null;
  }

  /**
   * Close a position. Two call shapes:
   *   - `close(symbol, exitPrice, reason)`: targets a specific symbol.
   *   - `close(exitPrice, reason)`: legacy; closes the first open position.
   */
  async close(
    a: string | number,
    b: number | CloseReason,
    c?: CloseReason,
  ): Promise<CloseEvent | null> {
    if (typeof a === 'string') {
      return this.closeBySymbol(a, b as number, c as CloseReason);
    }
    const firstSym = this.positions.keys().next().value as string | undefined;
    if (!firstSym) return null;
    return this.closeBySymbol(firstSym, a, b as CloseReason);
  }

  private async closeBySymbol(symbol: string, exitPrice: number, reason: CloseReason): Promise<CloseEvent | null> {
    const key = this.getBaseAsset(symbol);
    if (this.closingInProgress.has(key)) return null;
    const pos = this.positions.get(key);
    if (!pos) return null;

    this.closingInProgress.add(key);
    // Remove from registry BEFORE the async adapter call so concurrent ticks see no position.
    this.positions.delete(key);

    try {
      await this.adapter.closePosition(pos.orderId, reason);
    } catch (e) {
      this.log.warn('exit_order_failed', { err: (e as Error).message, symbol: key });
    } finally {
      this.closingInProgress.delete(key);
    }

    const pnl = this.risk.netPnl(pos.entryPrice, exitPrice, pos.side, pos.quantity);
    const event: CloseEvent = { position: pos, exitPrice, reason, pnl };
    this.appendCsv(key, event);

    this.pgWriter?.writeTrade({
      ...pos,
      exitPrice,
      reason,
      grossUsdt: pnl.grossUsdt,
      feesUsdt: pnl.feesUsdt,
      fundingUsdt: pnl.fundingUsdt,
      netUsdt: pnl.netUsdt,
      closedAt: Date.now(),
      attribution: this.attributions.get(key),
    } as any, key).catch(() => {});
    this.pgWriter?.removePosition(pos.orderId).catch(() => {});

    this.pgWriter?.writeOrder({
      orderId: pos.orderId,
      symbol: key,
      side: pos.side === 'LONG' ? 'SHORT' : 'LONG', // Exit side
      quantity: pos.quantity,
      price: exitPrice,
      status: 'CLOSED',
      fillPrice: exitPrice,
    }).catch(() => {});

    this.attributions.delete(key);
    this.log.info('position_closed', {
      symbol: key,
      side: pos.side,
      entry: pos.entryPrice,
      exit: exitPrice,
      reason,
      netUsdt: pnl.netUsdt,
      netInr: pnl.netInr,
    });
    return event;
  }

  /**
   * Called when the exchange-side algo TP/SL fills. Skips the adapter close call.
   * Shapes:
   *   - `notifyExchangeClose(symbol, exitPrice, reason)`
   *   - `notifyExchangeClose(exitPrice, reason)`  (legacy — first open position)
   */
  async notifyExchangeClose(
    a: string | number,
    b: number | CloseReason,
    c?: CloseReason,
  ): Promise<CloseEvent | null> {
    let symbol: string | undefined;
    let exitPrice: number;
    let reason: CloseReason;
    if (typeof a === 'string') {
      symbol = a.toUpperCase();
      exitPrice = b as number;
      reason = c as CloseReason;
    } else {
      symbol = this.positions.keys().next().value as string | undefined;
      exitPrice = a;
      reason = b as CloseReason;
    }
    if (!symbol) return null;
    const base = this.getBaseAsset(symbol);
    const pos = this.positions.get(base);
    if (!pos) return null;
    
    // We use the original symbol for the trade record but the base for the Map cleanup
    this.positions.delete(base);
    this.closingInProgress.delete(base);
    const pnl = this.risk.netPnl(pos.entryPrice, exitPrice, pos.side, pos.quantity);
    const event: CloseEvent = { position: pos, exitPrice, reason, pnl };
    this.appendCsv(symbol, event);

    this.pgWriter?.writeTrade({
      ...pos,
      exitPrice,
      reason,
      grossUsdt: pnl.grossUsdt,
      feesUsdt: pnl.feesUsdt,
      fundingUsdt: pnl.fundingUsdt,
      netUsdt: pnl.netUsdt,
      closedAt: Date.now(),
      attribution: this.attributions.get(symbol),
    } as any, symbol).catch(() => {});
    this.pgWriter?.removePositionBySymbol(symbol).catch(() => {});
    this.attributions.delete(symbol);
    this.log.info('position_closed', {
      symbol,
      side: pos.side,
      entry: pos.entryPrice,
      exit: exitPrice,
      reason,
      netUsdt: pnl.netUsdt,
      netInr: pnl.netInr,
      source: 'exchange',
    });
    return event;
  }

  /** Clear all positions (Hard Reset) */
  clearAllPositions(): void {
    this.positions.clear();
    this.attributions.clear();
    this.closingInProgress.clear();
    this.log.info('positions_hard_reset', { reason: 'bot_startup' });
  }

  /**
   * Restore position state after bot restart (startup reconciliation).
   * When `symbol` is omitted, derives the key from `pair`.
   */
  restoreFromExchange(params: {
    side: Side;
    entryPrice: number;
    quantity: number;
    pair: string;
    orderId: string;
    takeProfit: number;
    stopLoss: number;
    openedAt: number;
    notionalUsdt: number;
    symbol?: string;
    leverage?: number;
    liqPrice?: number;
  }): void {
    const displaySymbol = params.symbol ?? params.pair;
    const base = this.getBaseAsset(displaySymbol);
    const symbolKey = base;
    
    // Clean up anything that might have been there
    this.positions.delete(symbolKey);
    this.pgWriter?.removePositionBySymbol(displaySymbol).catch(() => {});

    const pos: TrackedPosition = {
      symbol: displaySymbol,
      side: params.side,
      entryPrice: params.entryPrice,
      quantity: params.quantity,
      takeProfit: params.takeProfit,
      stopLoss: params.stopLoss,
      openedAt: params.openedAt,
      pair: params.pair,
      notionalUsdt: params.notionalUsdt,
      marginInr: 0,
      orderId: params.orderId,
      leverage: params.leverage,
      liqPrice: params.liqPrice,
    };

    this.positions.set(symbolKey, pos);

    this.pgWriter?.upsertPosition({
      orderId: params.orderId,
      symbol: displaySymbol,
      side: params.side,
      quantity: params.quantity,
      entryPrice: params.entryPrice,
      leverage: params.leverage ?? 1,
      marginUsdt: params.notionalUsdt / (params.leverage ?? 1),
      liqPrice: params.liqPrice ?? 0,
      openedAt: params.openedAt,
    }).catch(() => {});

    this.log.info('position_restored', {
      symbol: displaySymbol,
      side: params.side,
      entry: params.entryPrice,
      qty: params.quantity,
      orderId: params.orderId,
    });
  }

  private appendCsv(symbol: string, event: CloseEvent): void {
    const csvPath = this.cfg.TRADE_LOG_PATH || this.cfg.TRADES_CSV_PATH;
    try {
      const dir = path.dirname(csvPath);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const headers =
        'time,symbol,side,entry,exit,qty,reason,grossUsdt,netUsdt,netInr,pctOnMargin,entrySignal,smcZone,htfBias,confidence\n';
      if (!fs.existsSync(csvPath)) fs.writeFileSync(csvPath, headers);
      const { position: p, exitPrice, reason, pnl } = event;
      const a = this.attributions.get(symbol);
      const row = [
        new Date().toISOString(),
        symbol,
        p.side,
        p.entryPrice,
        exitPrice,
        p.quantity,
        reason,
        pnl.grossUsdt.toFixed(6),
        pnl.netUsdt.toFixed(6),
        pnl.netInr.toFixed(2),
        pnl.pctOnMargin.toFixed(6),
        a?.entrySignal ?? '',
        a?.smcZone ?? '',
        a?.htfBias ?? '',
        a?.confidence?.toFixed(2) ?? '',
      ].join(',') + '\n';
      fs.appendFileSync(csvPath, row);
    } catch (e) {
      this.log.warn('csv_write_failed', { err: (e as Error).message });
    }
  }
}
