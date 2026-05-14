// Recursive-descent parser for NanoPine.
//
// Grammar (matches the plan):
//   program        = { statement } ;
//   statement      = indicatorDecl | inputDecl | assignment | exprStmt ;
//   indicatorDecl  = "indicator" "(" stringLit { "," kwarg } ")" ;
//   inputDecl      = ident "=" "input" "." kind "(" args ")" ;
//   assignment     = ident "=" expr ;
//   exprStmt       = call ;
//   expr           = ternary ;
//   ternary        = orExpr [ "?" expr ":" expr ] ;
//   orExpr         = andExpr { "or"  andExpr } ;
//   andExpr        = cmpExpr { "and" cmpExpr } ;
//   cmpExpr        = addExpr { ("=="|"!="|"<"|"<="|">"|">=") addExpr } ;
//   addExpr        = mulExpr { ("+"|"-") mulExpr } ;
//   mulExpr        = unary   { ("*"|"/"|"%") unary } ;
//   unary          = ("-"|"not") unary | postfix ;
//   postfix        = primary { "[" expr "]" | "(" argList ")" } ;
//   primary        = number | stringLit | "true" | "false" | "na" | ident | "(" expr ")" ;
//
// `assignment` is recognised by the lookahead `ident "="` (without `==`).
// Multiple statements on the same line are not supported — statements end at newline or EOF.

import { ParseError } from './errors.js';
import { Node } from './ast.js';

const INPUT_KINDS = new Set(['int', 'float', 'bool', 'source', 'string']);

export function parse(tokens) {
  const state = { tokens, i: 0 };

  // Skip leading blank lines.
  while (peek(state).type === 'newline') advance(state);

  const body = [];
  while (peek(state).type !== 'eof') {
    const stmt = parseStatement(state);
    if (stmt) body.push(stmt);
    // Statements terminated by newline(s) or EOF.
    while (peek(state).type === 'newline') advance(state);
  }
  return Node.Program(body);
}

function parseStatement(state) {
  const tok = peek(state);

  if (tok.type === 'indicator') {
    return parseIndicatorDecl(state);
  }

  // Assignment / input decl: ident '=' ...
  if (tok.type === 'ident' && peek(state, 1).type === '=') {
    return parseAssignmentOrInput(state);
  }

  // Otherwise: expression statement (e.g. plot(...), bgcolor(...), hline(...)).
  const expr = parseExpression(state);
  return Node.ExprStmt(expr, locOf(tok));
}

function parseIndicatorDecl(state) {
  const tok = expect(state, 'indicator');
  expect(state, '(');
  const nameTok = expect(state, 'string');
  const opts = [];
  while (peek(state).type === ',') {
    advance(state);
    opts.push(parseKwArg(state));
  }
  expect(state, ')');
  return Node.IndicatorDecl(nameTok.value, opts, locOf(tok));
}

function parseAssignmentOrInput(state) {
  const nameTok = expect(state, 'ident');
  expect(state, '=');
  // `input.<kind>(...)` is a special declaration form.
  if (peek(state).type === 'input' && peek(state, 1).type === '.') {
    advance(state); // 'input'
    advance(state); // '.'
    const kindTok = expect(state, 'ident');
    if (!INPUT_KINDS.has(kindTok.value)) {
      throw new ParseError(`Unknown input kind '${kindTok.value}'`, locOf(kindTok));
    }
    expect(state, '(');
    const { args, kwargs } = parseArgList(state);
    expect(state, ')');
    return Node.InputDecl(nameTok.value, kindTok.value, args, kwargs, locOf(nameTok));
  }
  const value = parseExpression(state);
  return Node.Assign(nameTok.value, value, locOf(nameTok));
}

function parseExpression(state) {
  return parseTernary(state);
}

function parseTernary(state) {
  const cond = parseOr(state);
  if (peek(state).type === '?') {
    const tok = advance(state);
    const then = parseExpression(state);
    expect(state, ':');
    const els = parseExpression(state);
    return Node.Ternary(cond, then, els, locOf(tok));
  }
  return cond;
}

function parseOr(state) {
  let left = parseAnd(state);
  while (peek(state).type === 'or') {
    const tok = advance(state);
    const right = parseAnd(state);
    left = Node.Binary('or', left, right, locOf(tok));
  }
  return left;
}

function parseAnd(state) {
  let left = parseCmp(state);
  while (peek(state).type === 'and') {
    const tok = advance(state);
    const right = parseCmp(state);
    left = Node.Binary('and', left, right, locOf(tok));
  }
  return left;
}

function parseCmp(state) {
  let left = parseAdd(state);
  while (isCmp(peek(state).type)) {
    const tok = advance(state);
    const right = parseAdd(state);
    left = Node.Binary(tok.type, left, right, locOf(tok));
  }
  return left;
}

function parseAdd(state) {
  let left = parseMul(state);
  while (peek(state).type === '+' || peek(state).type === '-') {
    const tok = advance(state);
    const right = parseMul(state);
    left = Node.Binary(tok.type, left, right, locOf(tok));
  }
  return left;
}

function parseMul(state) {
  let left = parseUnary(state);
  while (peek(state).type === '*' || peek(state).type === '/' || peek(state).type === '%') {
    const tok = advance(state);
    const right = parseUnary(state);
    left = Node.Binary(tok.type, left, right, locOf(tok));
  }
  return left;
}

function parseUnary(state) {
  const tok = peek(state);
  if (tok.type === '-') {
    advance(state);
    const arg = parseUnary(state);
    return Node.Unary('neg', arg, locOf(tok));
  }
  if (tok.type === 'not') {
    advance(state);
    const arg = parseUnary(state);
    return Node.Unary('not', arg, locOf(tok));
  }
  return parsePostfix(state);
}

function parsePostfix(state) {
  let node = parsePrimary(state);
  // Index `[k]` or call `(...)`. Calls are only valid when the primary was an identifier;
  // we enforce this when we see `(` after a non-ident.
  while (true) {
    const t = peek(state).type;
    if (t === '[') {
      const tok = advance(state);
      const idx = parseExpression(state);
      expect(state, ']');
      node = Node.Index(node, idx, locOf(tok));
      continue;
    }
    if (t === '(') {
      if (node.type !== 'Ident') {
        throw new ParseError(
          `Only identifiers can be called (got ${node.type})`,
          { line: node.line, col: node.col },
        );
      }
      const tok = advance(state);
      const { args, kwargs } = parseArgList(state);
      expect(state, ')');
      node = Node.Call(node.name, args, kwargs, locOf(tok));
      continue;
    }
    break;
  }
  return node;
}

function parsePrimary(state) {
  const tok = peek(state);
  switch (tok.type) {
    case 'number':
      advance(state);
      return Node.Number(tok.value, locOf(tok));
    case 'string':
      advance(state);
      return Node.String(tok.value, locOf(tok));
    case 'true':
      advance(state);
      return Node.Bool(true, locOf(tok));
    case 'false':
      advance(state);
      return Node.Bool(false, locOf(tok));
    case 'na':
      advance(state);
      return Node.NA(locOf(tok));
    case 'ident':
      advance(state);
      return Node.Ident(tok.value, locOf(tok));
    case '(': {
      advance(state);
      const expr = parseExpression(state);
      expect(state, ')');
      return expr;
    }
    default:
      throw new ParseError(`Unexpected token '${tok.type}'`, locOf(tok));
  }
}

function parseArgList(state) {
  const args = [];
  const kwargs = [];
  if (peek(state).type === ')') return { args, kwargs };
  while (true) {
    // Lookahead for `ident =` (kwarg) — but only if not `==`.
    if (peek(state).type === 'ident' && peek(state, 1).type === '=') {
      kwargs.push(parseKwArg(state));
    } else {
      if (kwargs.length > 0) {
        const t = peek(state);
        throw new ParseError('Positional arguments cannot follow keyword arguments', locOf(t));
      }
      args.push(parseExpression(state));
    }
    if (peek(state).type === ',') {
      advance(state);
      continue;
    }
    break;
  }
  return { args, kwargs };
}

function parseKwArg(state) {
  const nameTok = expect(state, 'ident');
  expect(state, '=');
  const value = parseExpression(state);
  return { name: nameTok.value, value };
}

function peek(state, k = 0) {
  return state.tokens[state.i + k] || { type: 'eof' };
}

function advance(state) {
  const t = state.tokens[state.i++];
  return t;
}

function expect(state, type) {
  const t = state.tokens[state.i];
  if (!t || t.type !== type) {
    throw new ParseError(
      `Expected '${type}' but got '${t ? t.type : 'eof'}'`,
      locOf(t || { line: 0, col: 0 }),
    );
  }
  state.i += 1;
  return t;
}

function isCmp(t) {
  return t === '==' || t === '!=' || t === '<' || t === '<=' || t === '>' || t === '>=';
}

function locOf(tok) {
  return { line: tok.line, col: tok.col };
}
