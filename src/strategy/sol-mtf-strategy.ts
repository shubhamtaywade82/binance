// Re-exports from the generalized MTF-SMC strategy.
// Orchestrator, dashboard, and existing tests import from this path — keep it stable.
export {
  MTF_SMC_TIMEFRAMES as SOL_MTF_TIMEFRAMES,
  evaluateMtfSmcStrategy as evaluateSolMtfStrategy,
  evaluateMtfSmcStrategy,
} from './mtf-smc-strategy';
export type {
  MtfSmcTf as SolMtfTf,
  MtfSmcStrategyInput as SolMtfStrategyInput,
  MtfSmcStrategyResult as SolMtfStrategyResult,
  MtfSmcTf,
  MtfSmcStrategyInput,
  MtfSmcStrategyResult,
} from './mtf-smc-strategy';
