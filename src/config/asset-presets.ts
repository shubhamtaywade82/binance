/**
 * Single-knob trading universe: pick asset → Binance USD-M symbol + CoinDCX futures pair.
 * Override with `TRADING_ASSET=custom` and set `BINANCE_SYMBOL` + `COINDCX_PAIR` yourself.
 */
export type TradingAsset = 'sol' | 'eth' | 'btc' | 'custom';

export const TRADING_ASSET_PRESETS: Record<Exclude<TradingAsset, 'custom'>, { binanceSymbol: string; coindcxPair: string }> =
  {
    sol: { binanceSymbol: 'SOLUSDT', coindcxPair: 'B-SOL_USDT' },
    eth: { binanceSymbol: 'ETHUSDT', coindcxPair: 'B-ETH_USDT' },
    btc: { binanceSymbol: 'BTCUSDT', coindcxPair: 'B-BTC_USDT' },
  };

export const normalizeTradingAsset = (raw: string | undefined): TradingAsset => {
  const s = String(raw ?? 'sol').trim().toLowerCase();
  if (s === 'sol' || s === 'eth' || s === 'btc' || s === 'custom') return s;
  return 'sol';
}
