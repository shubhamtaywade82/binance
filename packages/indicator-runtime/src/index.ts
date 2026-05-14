/**
 * @packageDocumentation
 * NanoPine — deterministic bar-by-bar indicator/strategy runtime (lexer, parser, interpreter).
 * Consumes normalized candles; emits a serializable render model for chart hosts.
 */

export * from './errors.js';
export * from './series.js';
export type { Expr, InputKind, KwArg, Program, Statement, SourceLoc } from './nodes.js';
export { Node } from './ast.js';
export { tokenize } from './lexer.js';
export type { Token, TokenBase } from './lexer.js';
export { parse } from './parser.js';
export { prepare, runBar } from './interpreter.js';
export type {
  AlertEvent,
  AlertOutput,
  BgColorOutput,
  BgColorSegment,
  BuiltinSeriesKey,
  CandleLike,
  ClosedTrade,
  CreateContextOptions,
  DeltaOutput,
  ExecutionContext,
  HLineOutput,
  HtfSeriesBundle,
  MarkerSeriesOutput,
  PlotSeriesOutput,
  RuntimeOutput,
  SerializedPoint,
  SerializedScriptOutput,
  StrategyMarker,
  StrategyPosition,
  StrategyState,
  StrategyStats,
} from './context.js';
export { createContext, tfDurationMs } from './context.js';
export { BUILTINS, isBuiltin } from './ta.js';
export type { BuiltinHandler } from './ta.js';
export {
  AtrState,
  EmaState,
  RollingExtreme,
  RsiState,
  SmaState,
  StdevState,
  SumState,
  TrendState,
  VwmaState,
  WmaState,
} from './ta-core.js';
