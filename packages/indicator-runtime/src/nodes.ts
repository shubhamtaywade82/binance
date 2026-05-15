/** Location attached to AST nodes for diagnostics. */
export interface SourceLoc {
  line?: number;
  col?: number;
}

export type KwArg = { name: string; value: Expr };

export type Expr =
  | ({ type: 'Number'; value: number } & SourceLoc)
  | ({ type: 'String'; value: string } & SourceLoc)
  | ({ type: 'Bool'; value: boolean } & SourceLoc)
  | ({ type: 'NA' } & SourceLoc)
  | ({ type: 'Ident'; name: string } & SourceLoc)
  | ({ type: 'Unary'; op: 'neg' | 'not'; arg: Expr } & SourceLoc)
  | ({ type: 'Binary'; op: string; left: Expr; right: Expr } & SourceLoc)
  | ({ type: 'Ternary'; cond: Expr; then: Expr; else: Expr } & SourceLoc)
  | ({ type: 'Index'; target: Expr; index: Expr } & SourceLoc)
  | ({ type: 'Call'; callee: string; args: Expr[]; kwargs: KwArg[] } & SourceLoc);

export type InputKind = 'int' | 'float' | 'bool' | 'source' | 'string';

export type Statement =
  | ({ type: 'IndicatorDecl'; name: string; opts: KwArg[] } & SourceLoc)
  | ({ type: 'StrategyDecl'; name: string; opts: KwArg[] } & SourceLoc)
  | ({ type: 'InputDecl'; name: string; kind: InputKind; args: Expr[]; kwargs: KwArg[] } & SourceLoc)
  | ({ type: 'Assign'; name: string; value: Expr } & SourceLoc)
  | ({ type: 'ExprStmt'; expr: Expr } & SourceLoc);

export interface Program {
  type: 'Program';
  body: Statement[];
}
