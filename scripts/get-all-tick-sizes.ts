import axios from 'axios';

async function run() {
  const url = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
  try {
    const resp = await axios.get(url);
    const symbols = resp.data.symbols;
    console.log(`Total symbols found: ${symbols.length}`);
    
    const results: any[] = [];
    for (const s of symbols) {
      const priceFilter = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
      const lotSize = s.filters.find((f: any) => f.filterType === 'LOT_SIZE');
      if (priceFilter && lotSize) {
        results.push({
          symbol: s.symbol,
          tickSize: priceFilter.tickSize,
          stepSize: lotSize.stepSize,
          minQty: lotSize.minQty
        });
      }
    }

    // Sort by tickSize ascending to find the "minimums"
    results.sort((a, b) => parseFloat(a.tickSize) - parseFloat(b.tickSize));

    console.log('\nAssets with smallest tickSize:');
    results.slice(0, 10).forEach(r => {
      console.log(`${r.symbol.padEnd(12)}: tickSize=${r.tickSize}`);
    });

    console.log('\nCommon Assets:');
    const common = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'PEPEUSDT', 'SHIBUSDT'];
    results.filter(r => common.includes(r.symbol)).forEach(r => {
      console.log(`${r.symbol.padEnd(12)}: tickSize=${r.tickSize}`);
    });

  } catch (e) {
    console.error('Failed:', e);
  }
}

run();
