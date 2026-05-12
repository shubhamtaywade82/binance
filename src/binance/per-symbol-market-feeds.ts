import { LocalOrderBook } from './orderbook';
import { AggTradeTape } from './trade-tape';

export interface PerSymbolMarketFeedsOptions {
  tapeCapacity?: number;
  /** Execution / strategy symbol — reuse orchestrator's book + tape instances for this key. */
  primarySymbol?: string;
  primaryBook?: LocalOrderBook;
  primaryTape?: AggTradeTape;
}

/**
 * Isolated {@link LocalOrderBook} + {@link AggTradeTape} per USD-M symbol for multiplex dashboards.
 * When {@link PerSymbolMarketFeedsOptions.primaryBook} is set for {@link PerSymbolMarketFeedsOptions.primarySymbol},
 * that slot shares the same instances as the orchestrator primary feed.
 */
export class PerSymbolMarketFeeds {
  private readonly books = new Map<string, LocalOrderBook>();
  private readonly tapes = new Map<string, AggTradeTape>();
  private readonly tapeCapacity: number;

  constructor(symbols: string[], opts: PerSymbolMarketFeedsOptions | number = {}) {
    const options: PerSymbolMarketFeedsOptions = typeof opts === 'number' ? { tapeCapacity: opts } : opts;
    this.tapeCapacity = options.tapeCapacity ?? 1000;
    const primary = options.primarySymbol?.trim().toUpperCase() ?? '';
    const uniq = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter((s) => s.length > 0))];
    for (const s of uniq) {
      const pb = options.primaryBook;
      const pt = options.primaryTape;
      const useShared = primary !== '' && s === primary && pb !== undefined && pt !== undefined;
      this.books.set(s, useShared ? pb : new LocalOrderBook());
      this.tapes.set(s, useShared ? pt : new AggTradeTape(this.tapeCapacity));
    }
  }

  listSymbols(): string[] {
    return [...this.books.keys()];
  }

  book(sym: string): LocalOrderBook {
    const k = sym.trim().toUpperCase();
    let ob = this.books.get(k);
    if (!ob) {
      ob = new LocalOrderBook();
      this.books.set(k, ob);
    }
    return ob;
  }

  tape(sym: string): AggTradeTape {
    const k = sym.trim().toUpperCase();
    let t = this.tapes.get(k);
    if (!t) {
      t = new AggTradeTape(this.tapeCapacity);
      this.tapes.set(k, t);
    }
    return t;
  }
}
