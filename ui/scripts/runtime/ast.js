// NanoPine AST node factories. Plain object nodes, JSON-serialisable so they can
// cross the worker boundary if needed.
//
// Node types:
//   { type: 'Program', body: Statement[] }
//   { type: 'IndicatorDecl', name: string, opts: KwArg[] }
//   { type: 'InputDecl', name: string, kind: 'int'|'float'|'bool'|'source'|'string', args: Expr[], kwargs: KwArg[] }
//   { type: 'Assign', name: string, value: Expr }
//   { type: 'ExprStmt', expr: Expr }
//   { type: 'Ternary', cond: Expr, then: Expr, else: Expr }
//   { type: 'Binary', op: string, left: Expr, right: Expr }
//   { type: 'Unary', op: 'neg'|'not', arg: Expr }
//   { type: 'Index', target: Expr, index: Expr }
//   { type: 'Call', callee: string, args: Expr[], kwargs: KwArg[] }
//   { type: 'Ident', name: string }
//   { type: 'Number', value: number }
//   { type: 'String', value: string }
//   { type: 'Bool', value: boolean }
//   { type: 'NA' }
//   KwArg: { name: string, value: Expr }
//
// Each node may carry `line` / `col` for error reporting.

export const Node = {
  Program: (body) => ({ type: 'Program', body }),
  IndicatorDecl: (name, opts, loc) => ({ type: 'IndicatorDecl', name, opts, ...loc }),
  StrategyDecl: (name, opts, loc) => ({ type: 'StrategyDecl', name, opts, ...loc }),
  InputDecl: (name, kind, args, kwargs, loc) => ({
    type: 'InputDecl',
    name,
    kind,
    args,
    kwargs,
    ...loc,
  }),
  Assign: (name, value, loc) => ({ type: 'Assign', name, value, ...loc }),
  ExprStmt: (expr, loc) => ({ type: 'ExprStmt', expr, ...loc }),
  Ternary: (cond, t, e, loc) => ({ type: 'Ternary', cond, then: t, else: e, ...loc }),
  Binary: (op, left, right, loc) => ({ type: 'Binary', op, left, right, ...loc }),
  Unary: (op, arg, loc) => ({ type: 'Unary', op, arg, ...loc }),
  Index: (target, index, loc) => ({ type: 'Index', target, index, ...loc }),
  Call: (callee, args, kwargs, loc) => ({ type: 'Call', callee, args, kwargs, ...loc }),
  Ident: (name, loc) => ({ type: 'Ident', name, ...loc }),
  Number: (value, loc) => ({ type: 'Number', value, ...loc }),
  String: (value, loc) => ({ type: 'String', value, ...loc }),
  Bool: (value, loc) => ({ type: 'Bool', value, ...loc }),
  NA: (loc) => ({ type: 'NA', ...loc }),
};
