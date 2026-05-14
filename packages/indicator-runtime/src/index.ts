/**
 * @packageDocumentation
 * NanoPine — deterministic bar-by-bar indicator/strategy runtime (lexer, parser, interpreter).
 * Consumes normalized candles; emits a serializable render model for chart hosts.
 */

export * from './errors';
export * from './series';
export type { Expr, InputKind, KwArg, Program, Statement, SourceLoc } from './nodes';
export { Node } from './ast';
export { tokenize } from './lexer';
export type { Token, TokenBase } from './lexer';
export { parse } from './parser';
export { prepare, runBar } from './interpreter';
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
} from './context';
export { createContext, tfDurationMs } from './context';
export { BUILTINS, isBuiltin } from './ta';
export type { BuiltinHandler } from './ta';
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
} from './ta-core';
