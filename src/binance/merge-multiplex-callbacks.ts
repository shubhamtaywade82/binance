import type { MultiplexCallbacks } from './ws-multiplex';

export const mergeMultiplexCallbacks = (primary: MultiplexCallbacks, secondary: MultiplexCallbacks): MultiplexCallbacks => {
  return {
    onKline: (symbol, interval, candle, isFinal) => {
      primary.onKline?.(symbol, interval, candle, isFinal);
      secondary.onKline?.(symbol, interval, candle, isFinal);
    },
    onBookTicker: (t) => {
      primary.onBookTicker?.(t);
      secondary.onBookTicker?.(t);
    },
    on24hrTicker: (u) => {
      primary.on24hrTicker?.(u);
      secondary.on24hrTicker?.(u);
    },
    onDepthPartial: (p) => {
      primary.onDepthPartial?.(p);
      secondary.onDepthPartial?.(p);
    },
    onDepthDiff: (d) => {
      primary.onDepthDiff?.(d);
      secondary.onDepthDiff?.(d);
    },
    onAggTrade: (t) => {
      primary.onAggTrade?.(t);
      secondary.onAggTrade?.(t);
    },
    onMarkPrice: (u) => {
      primary.onMarkPrice?.(u);
      secondary.onMarkPrice?.(u);
    },
    onForceOrder: (e) => {
      primary.onForceOrder?.(e);
      secondary.onForceOrder?.(e);
    },
    onError: (err) => {
      primary.onError?.(err);
      secondary.onError?.(err);
    },
    onReconnect: (attempt, reason) => {
      primary.onReconnect?.(attempt, reason);
      secondary.onReconnect?.(attempt, reason);
    },
    onServerShutdown: () => {
      primary.onServerShutdown?.();
      secondary.onServerShutdown?.();
    },
    onOpen: (route, url) => {
      primary.onOpen?.(route, url);
      secondary.onOpen?.(route, url);
    },
    onClose: (code, reason) => {
      primary.onClose?.(code, reason);
      secondary.onClose?.(code, reason);
    },
  };
}
