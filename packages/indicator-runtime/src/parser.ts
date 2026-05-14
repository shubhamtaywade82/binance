// Recursive-descent parser for NanoPine.

import { ParseError } from './errors.js';
import { Node } from './ast.js';
import type { Expr, InputKind, KwArg, Program, Statement } from './nodes.js';
import type { Token } from './lexer.js';

const INPUT_KINDS = new Set(['int', 'float', 'bool', 'source', 'string']);

interface ParseState {
  tokens: Token[];
  i: number;
}

export function parse(tokens: Token[]): Program {
  const state: ParseState = { tokens, i: 0 };

  while (peek(state).type === 'newline') advance(state);

  const body: Statement[] = [];
  while (peek(state).type !== 'eof') {
    const stmt = parseStatement(state);
    if (stmt) body.push(stmt);
    while (peek(state).type === 'newline') advance(state);
  }
  return Node.Program(body);
}

function parseStatement(state: ParseState): Statement | null {
  const tok = peek(state);

  if (tok.type === 'indicator') {
    return parseIndicatorDecl(state, 'IndicatorDecl', 'indicator');
  }

  if (tok.type === 'strategy') {
    return parseIndicatorDecl(state, 'StrategyDecl', 'strategy');
  }

  if (tok.type === 'ident' && peek(state, 1).type === '=') {
    return parseAssignmentOrInput(state);
  }

  const expr = parseExpression(state);
  return Node.ExprStmt(expr, locOf(tok));
}

function parseIndicatorDecl(
  state: ParseState,
  nodeName: 'IndicatorDecl' | 'StrategyDecl',
  keyword: string,
): Statement {
  const tok = expect(state, keyword);
  expect(state, '(');
  const nameTok = expect(state, 'string');
  const opts: KwArg[] = [];
  while (peek(state).type === ',') {
    advance(state);
    opts.push(parseKwArg(state));
  }
  expect(state, ')');
  const factory = nodeName === 'StrategyDecl' ? Node.StrategyDecl : Node.IndicatorDecl;
  return factory(nameTok.value, opts, locOf(tok));
}

function parseAssignmentOrInput(state: ParseState): Statement {
  const nameTok = expect(state, 'ident');
  expect(state, '=');
  if (peek(state).type === 'input' && peek(state, 1).type === '.') {
    advance(state);
    advance(state);
    const kindTok = expect(state, 'ident');
    const kindStr = kindTok.value;
    if (!INPUT_KINDS.has(kindStr)) {
      throw new ParseError(`Unknown input kind '${kindStr}'`, locOf(kindTok));
    }
    expect(state, '(');
    const { args, kwargs } = parseArgList(state);
    expect(state, ')');
    return Node.InputDecl(nameTok.value, kindStr as InputKind, args, kwargs, locOf(nameTok));
  }
  const value = parseExpression(state);
  return Node.Assign(nameTok.value, value, locOf(nameTok));
}

function parseExpression(state: ParseState): Expr {
  return parseTernary(state);
}

function parseTernary(state: ParseState): Expr {
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

function parseOr(state: ParseState): Expr {
  let left = parseAnd(state);
  while (peek(state).type === 'or') {
    const tok = advance(state);
    const right = parseAnd(state);
    left = Node.Binary('or', left, right, locOf(tok));
  }
  return left;
}

function parseAnd(state: ParseState): Expr {
  let left = parseCmp(state);
  while (peek(state).type === 'and') {
    const tok = advance(state);
    const right = parseCmp(state);
    left = Node.Binary('and', left, right, locOf(tok));
  }
  return left;
}

function parseCmp(state: ParseState): Expr {
  let left = parseAdd(state);
  while (isCmp(peek(state).type)) {
    const tok = advance(state);
    const right = parseAdd(state);
    left = Node.Binary(tok.type, left, right, locOf(tok));
  }
  return left;
}

function parseAdd(state: ParseState): Expr {
  let left = parseMul(state);
  while (peek(state).type === '+' || peek(state).type === '-') {
    const tok = advance(state);
    const right = parseMul(state);
    left = Node.Binary(tok.type, left, right, locOf(tok));
  }
  return left;
}

function parseMul(state: ParseState): Expr {
  let left = parseUnary(state);
  while (peek(state).type === '*' || peek(state).type === '/' || peek(state).type === '%') {
    const tok = advance(state);
    const right = parseUnary(state);
    left = Node.Binary(tok.type, left, right, locOf(tok));
  }
  return left;
}

function parseUnary(state: ParseState): Expr {
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

function parsePostfix(state: ParseState): Expr {
  let node = parsePrimary(state);
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
        throw new ParseError(`Only identifiers can be called (got ${node.type})`, {
          line: node.line,
          col: node.col,
        });
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

function parsePrimary(state: ParseState): Expr {
  const tok = peek(state);
  switch (tok.type) {
    case 'number':
      advance(state);
      return Node.Number((tok as Token & { value: number }).value, locOf(tok));
    case 'string':
      advance(state);
      return Node.String((tok as Token & { value: string }).value, locOf(tok));
    case 'true':
      advance(state);
      return Node.Bool(true, locOf(tok));
    case 'false':
      advance(state);
      return Node.Bool(false, locOf(tok));
    case 'na':
      advance(state);
      return Node.NA(locOf(tok));
    case 'ident': {
      advance(state);
      return Node.Ident((tok as Token & { value: string }).value, locOf(tok));
    }
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

function parseArgList(state: ParseState): { args: Expr[]; kwargs: KwArg[] } {
  const args: Expr[] = [];
  const kwargs: KwArg[] = [];
  if (peek(state).type === ')') return { args, kwargs };
  while (true) {
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

function parseKwArg(state: ParseState): KwArg {
  const nameTok = expect(state, 'ident');
  expect(state, '=');
  const value = parseExpression(state);
  return { name: nameTok.value, value };
}

function peek(state: ParseState, k = 0): Token {
  return state.tokens[state.i + k] ?? { type: 'eof', line: 0, col: 0 };
}

function advance(state: ParseState): Token {
  return state.tokens[state.i++]!;
}

function expect(state: ParseState, type: 'ident'): Extract<Token, { type: 'ident' }>;
function expect(state: ParseState, type: 'string'): Extract<Token, { type: 'string' }>;
function expect(state: ParseState, type: 'number'): Extract<Token, { type: 'number' }>;
function expect(state: ParseState, type: string): Token;
function expect(state: ParseState, type: string): Token {
  const t = state.tokens[state.i];
  if (!t || t.type !== type) {
    throw new ParseError(`Expected '${type}' but got '${t ? t.type : 'eof'}'`, locOf(t ?? { line: 0, col: 0 }));
  }
  state.i += 1;
  return t;
}

function isCmp(t: string): boolean {
  return t === '==' || t === '!=' || t === '<' || t === '<=' || t === '>' || t === '>=';
}

function locOf(tok: Pick<Token, 'line' | 'col'>): { line: number; col: number } {
  return { line: tok.line, col: tok.col };
}
