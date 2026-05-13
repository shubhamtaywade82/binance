export interface ExecutionContext {
  spreadBps: number;
  bookThinning: number;
  volRegimeFlag: number;
  cancelIntensity: number;
  liquidityGap: number;
}

export interface ExecutionGateResult {
  skip: boolean;
  reason?: string;
}

const SPREAD_LIMIT_BPS = 15;
const BOOK_THINNING_LIMIT = -0.1;
const LIQUIDITY_GAP_THRESHOLD = 0.5;

export const shouldSkipEntry = (context: ExecutionContext): ExecutionGateResult => {
  if (context.spreadBps > SPREAD_LIMIT_BPS) {
    return { skip: true, reason: `spread ${context.spreadBps.toFixed(1)} bps > ${SPREAD_LIMIT_BPS} limit` };
  }

  if (context.bookThinning < BOOK_THINNING_LIMIT) {
    return { skip: true, reason: `book thinning ${context.bookThinning.toFixed(3)} < ${BOOK_THINNING_LIMIT} threshold` };
  }

  if (context.volRegimeFlag > 0 && context.liquidityGap > LIQUIDITY_GAP_THRESHOLD) {
    return {
      skip: true,
      reason: `vol regime active with liquidity gap ${context.liquidityGap.toFixed(3)} > ${LIQUIDITY_GAP_THRESHOLD}`,
    };
  }

  return { skip: false };
};
