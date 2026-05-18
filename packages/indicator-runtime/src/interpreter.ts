// Tree-walking interpreter for NanoPine.
//
// Two entry points:
//   - prepare(program, ctx)            — wires indicator metadata + input defaults
//   - runBar(program, ctx, barIndex)   — evaluates statements for one bar

import { RuntimeError, ValidationError } from './errors.js';
import { Series } from './series.js';
import { BUILTINS, isBuiltin } from './ta.js';
import type { ExecutionContext } from './context.js';
import type { Expr, InputKind, Program, Statement } from './nodes.js';

export function prepare(program: Program, ctx: ExecutionContext): void {
  (ctx as unknown as { __program?: Program }).__program = program;
  let seenHeader = false;
  for (const stmt of program.body) {
    if (stmt.type === 'IndicatorDecl' || stmt.type === 'StrategyDecl') {
      if (seenHeader) {
        throw new ValidationError("Multiple 'indicator' or 'strategy' declarations", {
          line: stmt.line,
          col: stmt.col,
        });
      }
      seenHeader = true;
      ctx.meta.name = stmt.name;
      ctx.meta.kind = stmt.type === 'StrategyDecl' ? 'strategy' : 'indicator';
      ctx.meta.opts = {};
      for (const kw of stmt.opts) {
        ctx.meta.opts[kw.name] = evalConstExpr(kw.value, ctx);
      }
      if (ctx.meta.kind === 'strategy') {
        ctx.initStrategy(ctx.meta.opts);
      }
    } else if (stmt.type === 'InputDecl') {
      if (!ctx.inputs.has(stmt.name)) {
        const def = stmt.args.length > 0 ? evalConstExpr(stmt.args[0]!, ctx) : null;
        ctx.inputs.set(stmt.name, coerceInput(def, stmt.kind, stmt.name, ctx));
      } else if (stmt.kind === 'source') {
        const raw = ctx.inputs.get(stmt.name);
        if (typeof raw === 'string' && raw in ctx.builtins) {
          ctx.inputs.set(stmt.name, ctx.builtins[raw as keyof typeof ctx.builtins]);
        }
      }
    } else if (stmt.type === 'FunctionDecl') {
      // validated at call-time
    }
  }
}

export function runBar(program: Program, ctx: ExecutionContext, barIndex: number): void {
  ctx.resetForBar(barIndex);
  for (const stmt of program.body) {
    if (
      stmt.type === 'IndicatorDecl' ||
      stmt.type === 'StrategyDecl' ||
      stmt.type === 'InputDecl' ||
      stmt.type === 'FunctionDecl'
    )
      continue;
    execStatement(stmt, ctx);
  }
  if (ctx.meta.kind === 'strategy') ctx.tickStrategyBar();
}

function execStatement(stmt: Statement, ctx: ExecutionContext): void {
  ctx.tickNodeBudget();
  switch (stmt.type) {
    case 'Assign': {
      const value = evalExpr(stmt.value, ctx);
      ctx.assign(stmt.name, value);
      return;
    }
    case 'ExprStmt': {
      evalExpr(stmt.expr, ctx);
      return;
    }
    default:
      throw new RuntimeError(`Unexpected statement type ${(stmt as Statement).type}`, {
        line: (stmt as Statement).line,
        col: (stmt as Statement).col,
      });
  }
}

function evalExpr(node: Expr, ctx: ExecutionContext): unknown {
  ctx.tickNodeBudget();
  switch (node.type) {
    case 'Number':
      return node.value;
    case 'String':
      return node.value;
    case 'Bool':
      return node.value;
    case 'NA':
      return NaN;
    case 'Ident': {
      const v = ctx.resolve(node.name);
      if (v === undefined) {
        throw new RuntimeError(`Unknown identifier '${node.name}'`, {
          line: node.line,
          col: node.col,
        });
      }
      return v;
    }
    case 'Unary': {
      const arg = evalExpr(node.arg, ctx);
      if (node.op === 'neg') return -toNumber(arg);
      if (node.op === 'not') return !toBool(arg);
      throw new RuntimeError(`Unknown unary op ${node.op}`, { line: node.line, col: node.col });
    }
    case 'Binary':
      return evalBinary(node, ctx);
    case 'Ternary': {
      const cond = toBool(evalExpr(node.cond, ctx));
      return cond ? evalExpr(node.then, ctx) : evalExpr(node.else, ctx);
    }
    case 'Index': {
      const target = evalExpr(node.target, ctx);
      const idx = toNumber(evalExpr(node.index, ctx));
      if (!(target instanceof Series)) {
        throw new RuntimeError('Index target is not a series', {
          line: node.line,
          col: node.col,
        });
      }
      return target.get(idx | 0);
    }
    case 'Call':
      return evalCall(node, ctx);
    default: {
      const n = node as Expr;
      throw new RuntimeError(`Unknown expression type ${n.type}`, { line: n.line, col: n.col });
    }
  }
}

function evalBinary(node: Extract<Expr, { type: 'Binary' }>, ctx: ExecutionContext): unknown {
  if (node.op === 'and') {
    const l = toBool(evalExpr(node.left, ctx));
    if (!l) return false;
    return toBool(evalExpr(node.right, ctx));
  }
  if (node.op === 'or') {
    const l = toBool(evalExpr(node.left, ctx));
    if (l) return true;
    return toBool(evalExpr(node.right, ctx));
  }

  const left = evalExpr(node.left, ctx);
  const right = evalExpr(node.right, ctx);
  const a = toNumber(left);
  const b = toNumber(right);
  let result: number | boolean;
  switch (node.op) {
    case '+':
      result = a + b; break;
    case '-':
      result = a - b; break;
    case '*':
      result = a * b; break;
    case '/':
      result = b === 0 ? NaN : a / b; break;
    case '%':
      result = b === 0 ? NaN : a % b; break;
    case '==':
      result = a === b; break;
    case '!=':
      result = a !== b; break;
    case '<':
      result = a < b; break;
    case '<=':
      result = a <= b; break;
    case '>':
      result = a > b; break;
    case '>=':
      result = a >= b; break;
    default:
      throw new RuntimeError(`Unknown binary op ${node.op}`, { line: node.line, col: node.col });
  }

  if (typeof result === 'number' && (left instanceof Series || right instanceof Series)) {
    let s = ctx.callState.get(node) as Series | undefined;
    if (!s) {
      s = new Series(ctx.capacity);
      ctx.callState.set(node, s);
    }
    s.push(result);
    return s;
  }
  return result;
}

function evalCall(node: Extract<Expr, { type: 'Call' }>, ctx: ExecutionContext): unknown {
  if (!isBuiltin(node.callee)) {
    const program = (ctx as unknown as { __program?: Program }).__program;
    const decl = program?.body.find(
      (s) => s.type === 'FunctionDecl' && s.name === node.callee,
    ) as Extract<Statement, { type: 'FunctionDecl' }> | undefined;
    if (!decl) {
      throw new RuntimeError(`Unknown function '${node.callee}'`, {
        line: node.line,
        col: node.col,
      });
    }
    const args = node.args.map((a) => evalExpr(a, ctx));
    const prior: Array<[string, unknown | undefined]> = [];
    for (let i = 0; i < decl.params.length; i++) {
      const name = decl.params[i]!;
      prior.push([name, ctx.resolve(name)]);
      ctx.assign(name, args[i] ?? NaN);
    }
    const result = evalExpr(decl.body, ctx);
    for (const [name, prev] of prior) {
      if (prev === undefined) ctx.userSeries.delete(name);
      else ctx.assign(name, prev);
    }
    return result;
  }
  const args = node.args.map((a) => evalExpr(a, ctx));
  const handler = BUILTINS[node.callee]!;
  return handler(ctx, node, args, node.kwargs, (n) => evalExpr(n, ctx));
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Series) return v.get(0);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (v instanceof Series) {
    const x = v.get(0);
    return Number.isFinite(x) && x !== 0;
  }
  return Boolean(v);
}

function evalConstExpr(node: Expr, ctx: ExecutionContext): unknown {
  switch (node.type) {
    case 'Number':
      return node.value;
    case 'String':
      return node.value;
    case 'Bool':
      return node.value;
    case 'NA':
      return NaN;
    case 'Unary': {
      const a = evalConstExpr(node.arg, ctx);
      if (node.op === 'neg') return -Number(a);
      if (node.op === 'not') return !a;
      break;
    }
    case 'Binary': {
      const a = evalConstExpr(node.left, ctx);
      const b = evalConstExpr(node.right, ctx);
      switch (node.op) {
        case '+':
          return Number(a) + Number(b);
        case '-':
          return Number(a) - Number(b);
        case '*':
          return Number(a) * Number(b);
        case '/':
          return Number(a) / Number(b);
        case '%':
          return Number(a) % Number(b);
        default:
          break;
      }
      break;
    }
    default:
      break;
  }
  throw new ValidationError(`Non-constant expression in declaration context (${node.type})`, {
    line: node.line,
    col: node.col,
  });
}

function coerceInput(value: unknown, kind: InputKind, name: string, ctx: ExecutionContext): unknown {
  switch (kind) {
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new ValidationError(`Input '${name}' (int) must be a finite number`);
      }
      return Math.round(n);
    }
    case 'float': {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new ValidationError(`Input '${name}' (float) must be a finite number`);
      }
      return n;
    }
    case 'bool':
      return Boolean(value);
    case 'string':
      return String(value ?? '');
    case 'source': {
      const seriesName = String(value ?? 'close');
      if (seriesName in ctx.builtins) return ctx.builtins[seriesName as keyof typeof ctx.builtins];
      return seriesName;
    }
    case 'color':
      return String(value ?? '#42a5f5');
    default:
      return value;
  }
}
