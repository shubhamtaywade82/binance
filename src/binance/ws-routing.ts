/**
 * Routes USD-M Futures WebSocket streams to Binance `/public` vs `/market` hosts.
 * @see https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Important-WebSocket-Change-Notice
 */
export type BinanceProductWs = 'usdm' | 'usdm_demo' | 'spot';
export type BinanceUsdmWsRoute = 'market' | 'public';
export type BinanceWsRoute = BinanceUsdmWsRoute | 'spot';

const ROUTED_SUFFIX = /\/(market|public|private)(\/(ws|stream))?$/;
const STREAM_SUFFIX = /\/(ws|stream)$/;

export const normalizeWsRoot = (baseWsUrl: string, product: BinanceProductWs): string => {
  let root = baseWsUrl.replace(/\/$/, '');
  if (product !== 'spot') {
    root = root.replace(ROUTED_SUFFIX, '');
  } else {
    root = root.replace(STREAM_SUFFIX, '');
  }
  return root;
}

export const routeForStream = (product: BinanceProductWs, stream: string): BinanceWsRoute => {
  if (product === 'spot') return 'spot';
  const lower = stream.toLowerCase();
  if (
    lower === '!bookticker' ||
    lower.includes('@bookticker') ||
    lower.includes('@depth')
  ) {
    return 'public';
  }
  return 'market';
}

export const isForceOrderStream = (stream: string): boolean => {
  return stream.toLowerCase().includes('@forceorder');
}

export const groupStreamsByRoute = (product: BinanceProductWs, streams: Iterable<string>): Map<BinanceWsRoute, string[]> => {
  const grouped = new Map<BinanceWsRoute, string[]>();
  for (const stream of streams) {
    const route = routeForStream(product, stream);
    const list = grouped.get(route) ?? [];
    list.push(stream);
    grouped.set(route, list);
  }
  return grouped;
}

export const buildCombinedStreamUrl = (baseWsUrl: string, product: BinanceProductWs, route: BinanceWsRoute, streams: string[]): string => {
  const root = normalizeWsRoot(baseWsUrl, product);
  const joined = streams.join('/');
  if (product === 'spot') return `${root}/stream?streams=${joined}`;
  return `${root}/${route}/stream?streams=${joined}`;
}

export const buildRawStreamUrl = (baseWsUrl: string, product: BinanceProductWs, route: BinanceWsRoute, stream: string): string => {
  const root = normalizeWsRoot(baseWsUrl, product);
  if (product === 'spot') return `${root}/ws/${stream}`;
  return `${root}/${route}/ws/${stream}`;
}
