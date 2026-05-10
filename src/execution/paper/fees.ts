export function computeFee(notional: number, isTaker: boolean, taker: number, maker: number): number {
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  return notional * (isTaker ? taker : maker);
}
