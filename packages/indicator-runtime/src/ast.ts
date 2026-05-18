// NanoPine AST node factories. Plain object nodes, JSON-serialisable so they can
// cross the worker boundary if needed.

import type { Expr, InputKind, KwArg, Program, Statement } from './nodes.js';
import type { SourceLoc } from './nodes.js';

export const Node = {
  Program: (body: Statement[]): Program => ({ type: 'Program', body }),
  IndicatorDecl: (name: string, opts: KwArg[], loc?: SourceLoc): Statement => ({
    type: 'IndicatorDecl',
    name,
    opts,
    ...loc,
  }),
  StrategyDecl: (name: string, opts: KwArg[], loc?: SourceLoc): Statement => ({
    type: 'StrategyDecl',
    name,
    opts,
    ...loc,
  }),
  FunctionDecl: (name: string, params: string[], body: Expr, loc?: SourceLoc): Statement => ({
    type: 'FunctionDecl',
    name,
    params,
    body,
    ...loc,
  }),
  InputDecl: (name: string, kind: InputKind, args: Expr[], kwargs: KwArg[], loc?: SourceLoc): Statement => ({
    type: 'InputDecl',
    name,
    kind,
    args,
    kwargs,
    ...loc,
  }),
  Assign: (name: string, value: Expr, loc?: SourceLoc): Statement => ({
    type: 'Assign',
    name,
    value,
    ...loc,
  }),
  ExprStmt: (expr: Expr, loc?: SourceLoc): Statement => ({
    type: 'ExprStmt',
    expr,
    ...loc,
  }),
  Ternary: (cond: Expr, t: Expr, e: Expr, loc?: SourceLoc): Expr => ({
    type: 'Ternary',
    cond,
    then: t,
    else: e,
    ...loc,
  }),
  Binary: (op: string, left: Expr, right: Expr, loc?: SourceLoc): Expr => ({
    type: 'Binary',
    op,
    left,
    right,
    ...loc,
  }),
  Unary: (op: 'neg' | 'not', arg: Expr, loc?: SourceLoc): Expr => ({
    type: 'Unary',
    op,
    arg,
    ...loc,
  }),
  Index: (target: Expr, index: Expr, loc?: SourceLoc): Expr => ({
    type: 'Index',
    target,
    index,
    ...loc,
  }),
  Call: (callee: string, args: Expr[], kwargs: KwArg[], loc?: SourceLoc): Expr => ({
    type: 'Call',
    callee,
    args,
    kwargs,
    ...loc,
  }),
  Ident: (name: string, loc?: SourceLoc): Expr => ({
    type: 'Ident',
    name,
    ...loc,
  }),
  Number: (value: number, loc?: SourceLoc): Expr => ({
    type: 'Number',
    value,
    ...loc,
  }),
  String: (value: string, loc?: SourceLoc): Expr => ({
    type: 'String',
    value,
    ...loc,
  }),
  Bool: (value: boolean, loc?: SourceLoc): Expr => ({
    type: 'Bool',
    value,
    ...loc,
  }),
  NA: (loc?: SourceLoc): Expr => ({ type: 'NA', ...loc }),
};
