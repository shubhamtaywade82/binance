import { fetchBinanceExchangeInfoForSymbols } from '../src/binance/rest-exchange-info';
import { loadConfig, multiplexBinanceSymbols, binanceRestBase } from '../src/config';

async function run() {
  const cfg = loadConfig();
  const base = binanceRestBase(cfg);
  const symbols = multiplexBinanceSymbols(cfg);
  console.log(`Fetching exchange info for: ${symbols.join(', ')} from ${base}`);
  
  try {
    const map = await fetchBinanceExchangeInfoForSymbols(base, symbols);
    for (const [sym, prec] of map.entries()) {
      console.log(`${sym}: tickSize=${prec.tickSize}, stepSize=${prec.stepSize}, minQty=${prec.minQty}`);
    }
  } catch (e) {
    console.error('Failed to fetch:', e);
  }
}

run();
