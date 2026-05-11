import type { DepthDiff } from './orderbook';

export interface DepthDeltaEvent {
  U: number;
  u: number;
  bids: [string, string][];
  asks: [string, string][];
  pu?: number;
  E?: number;
  s?: string;
}

export function depthDeltaToDiff(ev: DepthDeltaEvent, symbol?: string): DepthDiff & { s: string } {
  return {
    s: (ev.s ?? symbol ?? '').toUpperCase(),
    U: ev.U,
    u: ev.u,
    pu: ev.pu,
    E: ev.E,
    bids: ev.bids,
    asks: ev.asks,
  };
}
