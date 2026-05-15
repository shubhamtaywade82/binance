/**
 * Clamps order quantity so the total notional (`qty * price`) does not exceed `maxNotionalUsdt`.
 *
 * Returns the original quantity when the cap is disabled (`maxNotionalUsdt <= 0`)
 * or the order already fits within the cap.
 */
export const applyNotionalCap = (qty: number, price: number, maxNotionalUsdt: number): number => {
  if (maxNotionalUsdt <= 0) return qty;
  if (price <= 0) return qty;
  const maxQty = maxNotionalUsdt / price;
  return Math.min(qty, maxQty);
};
