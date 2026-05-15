// Generates a TypeScript scaffold for live trading from a parsed NanoPine strategy.
// The output is intentionally a *scaffold*: it reuses src/strategy/indicators.ts for
// EMA/RSI/etc. and lays out the entry / exit guards as TODOs the operator must wire
// into the orchestrator. The generator's job is to remove the boilerplate of
// translating syntax — not to ship a runnable live strategy unsupervised.

const SUPPORTED_TA = new Set([
  'ema',
  'sma',
  'rsi',
  'atr',
  'crossover',
  'crossunder',
  'highest',
  'lowest',
]);

export function generateStrategyTs(scriptMeta, program) {
  const isStrategy = program.body.some((s) => s.type === 'StrategyDecl');
  if (!isStrategy) {
    throw new Error('Export TS is only available for strategy(...) scripts.');
  }
  const decl = program.body.find((s) => s.type === 'StrategyDecl');
  const inputs = program.body.filter((s) => s.type === 'InputDecl');
  const assigns = program.body.filter((s) => s.type === 'Assign');
  const stmts = program.body.filter((s) => s.type === 'ExprStmt');
  const entries = stmts.filter(
    (s) => s.expr.type === 'Call' && s.expr.callee === 'entry',
  );
  const exits = stmts.filter(
    (s) => s.expr.type === 'Call' && s.expr.callee === 'exit',
  );

  const safeName = identFromName(scriptMeta.name);
  const filename = `${kebab(safeName)}.ts`;

  const inputDecls = inputs
    .map((i) => {
      const def = constLit(i.args[0]);
      const tsType = i.kind === 'bool' ? 'boolean' : i.kind === 'string' || i.kind === 'source' ? 'string' : 'number';
      return `  ${i.name}: ${tsType};`;
    })
    .join('\n');

  const inputDefaults = inputs
    .map((i) => {
      const def = constLit(i.args[0]);
      return `  ${i.name}: ${def},`;
    })
    .join('\n');

  const assignLines = assigns
    .map((a) => `  const ${a.name} = ${exprToTs(a.value)};`)
    .join('\n');

  const entryLines = entries
    .map((s) => {
      const args = s.expr.args || [];
      const cond = args[0] ? exprToTs(args[0]) : 'false';
      const side =
        args[1] && args[1].type === 'String' ? args[1].value : 'long';
      return `  if (${cond}) {\n    return { action: 'open', side: '${side === 'short' ? 'SHORT' : 'LONG'}' };\n  }`;
    })
    .join('\n');

  const exitLines = exits
    .map((s) => {
      const args = s.expr.args || [];
      const cond = args[0] ? exprToTs(args[0]) : 'false';
      return `  if (${cond}) {\n    return { action: 'close' };\n  }`;
    })
    .join('\n');

  const today = new Date().toISOString().slice(0, 10);
  const source = `// Auto-generated from NanoPine script "${scriptMeta.name}" on ${today}.
// This is a scaffold — wire it into your orchestrator manually and verify in paper
// mode before flipping PLACE_ORDER=true. The runtime equivalents live in
// src/strategy/indicators.ts; helpers below assume the same Candle[] shape as the
// rest of the bot.

import type { Candle } from '../types';
import { ema, sma, rsi, atr } from './indicators';

export interface ${safeName}Inputs {
${inputDecls || '  /* no inputs */'}
}

export const ${safeName}Defaults: ${safeName}Inputs = {
${inputDefaults || '  /* no defaults */'}
};

export type ${safeName}Signal =
  | { action: 'open'; side: 'LONG' | 'SHORT' }
  | { action: 'close' }
  | { action: 'hold' };

/** Evaluate the strategy on the latest closed candle. */
export function evaluate${safeName}(
  candles: Candle[],
  inputs: ${safeName}Inputs = ${safeName}Defaults,
): ${safeName}Signal {
  if (candles.length < 50) return { action: 'hold' };
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const i = candles.length - 1;

  // Helpers — these read the latest value of each TA series.
  const _ema = (src: number[], len: number): number => {
    const s = ema(src, len);
    return s[s.length - 1];
  };
  const _sma = (src: number[], len: number): number => {
    const s = sma ? sma(src, len) : ema(src, len);
    return s[s.length - 1];
  };
  const _rsi = (src: number[], len: number): number => {
    const s = rsi(src, len);
    return s[s.length - 1];
  };
  const _atr = (len: number): number => {
    const s = atr(candles, len);
    return s[s.length - 1];
  };
  const _highest = (src: number[], len: number): number => {
    return Math.max(...src.slice(-len));
  };
  const _lowest = (src: number[], len: number): number => {
    return Math.min(...src.slice(-len));
  };
  const _crossover = (a: number, b: number, aPrev: number, bPrev: number): boolean =>
    a > b && aPrev <= bPrev;
  const _crossunder = (a: number, b: number, aPrev: number, bPrev: number): boolean =>
    a < b && aPrev >= bPrev;

  // Builtin series shortcuts at the latest bar.
  const open = candles[i].open;
  const high = candles[i].high;
  const low = candles[i].low;
  const close = candles[i].close;
  const volume = candles[i].volume;
  const hl2 = (high + low) / 2;
  const hlc3 = (high + low + close) / 3;
  const ohlc4 = (open + high + low + close) / 4;
  // Suppress unused-variable warnings — the generator includes every alias even when
  // a particular script doesn't reference it. Strip what you don't need.
  void open; void high; void low; void volume; void hl2; void hlc3; void ohlc4;
  void _sma; void _rsi; void _atr; void _highest; void _lowest;
  void closes; void highs; void lows; void volumes;

  // ── Script-derived assignments ─────────────────────────────────────────────
${assignLines || '  /* no assignments */'}

  // ── Entry signals (in declaration order) ───────────────────────────────────
${entryLines || '  /* no entries */'}

  // ── Exit signals ───────────────────────────────────────────────────────────
${exitLines || '  /* no exits */'}

  return { action: 'hold' };
}

// TODO: wire evaluate${safeName} into your orchestrator. Suggested flow:
//   1. Subscribe to a (symbol, timeframe) MultiTimeframeStore series.
//   2. On each closed kline, call evaluate${safeName}(candles) and dispatch via
//      your ExecutionAdapter. Validate behaviour in paper mode first.
`;

  return { filename, source };
}

function exprToTs(node) {
  if (!node) return 'undefined';
  switch (node.type) {
    case 'Number':
      return String(node.value);
    case 'String':
      return JSON.stringify(node.value);
    case 'Bool':
      return node.value ? 'true' : 'false';
    case 'NA':
      return 'NaN';
    case 'Ident':
      return node.name;
    case 'Unary':
      return node.op === 'not'
        ? `!(${exprToTs(node.arg)})`
        : `-(${exprToTs(node.arg)})`;
    case 'Binary': {
      const opMap = { and: '&&', or: '||' };
      const op = opMap[node.op] || node.op;
      return `(${exprToTs(node.left)} ${op} ${exprToTs(node.right)})`;
    }
    case 'Ternary':
      return `(${exprToTs(node.cond)} ? ${exprToTs(node.then)} : ${exprToTs(node.else)})`;
    case 'Index':
      // close[1] in NanoPine → closes[closes.length - 1 - 1] in TS.
      return `${seriesArrayForIdent(node.target)}[${seriesArrayForIdent(node.target)}.length - 1 - (${exprToTs(node.index)})]`;
    case 'Call': {
      if (node.callee === 'entry' || node.callee === 'exit' || node.callee === 'plot' || node.callee === 'plotshape' || node.callee === 'hline' || node.callee === 'bgcolor' || node.callee === 'alert') {
        return '/* TODO output: ' + node.callee + ' */ true';
      }
      if (SUPPORTED_TA.has(node.callee)) {
        return callToTs(node);
      }
      if (node.callee === 'security') {
        return `/* TODO: security(${node.args.map(exprToTs).join(', ')}) */ NaN`;
      }
      return `/* TODO: ${node.callee} unsupported in TS export */ NaN`;
    }
    default:
      return `/* TODO ${node.type} */`;
  }
}

function callToTs(node) {
  const argsTs = node.args.map(exprToTs);
  switch (node.callee) {
    case 'ema':
      return `_ema(${seriesArrayForIdent(node.args[0])}, ${argsTs[1] || '14'})`;
    case 'sma':
      return `_sma(${seriesArrayForIdent(node.args[0])}, ${argsTs[1] || '14'})`;
    case 'rsi':
      return `_rsi(${seriesArrayForIdent(node.args[0])}, ${argsTs[1] || '14'})`;
    case 'atr':
      return `_atr(${argsTs[0] || '14'})`;
    case 'highest':
      return `_highest(${seriesArrayForIdent(node.args[0])}, ${argsTs[1] || '14'})`;
    case 'lowest':
      return `_lowest(${seriesArrayForIdent(node.args[0])}, ${argsTs[1] || '14'})`;
    case 'crossover':
    case 'crossunder': {
      const fn = node.callee === 'crossover' ? '_crossover' : '_crossunder';
      const a = exprToTs(node.args[0]);
      const b = exprToTs(node.args[1]);
      const aPrev = `/* prev */ ${seriesArrayForIdent(node.args[0])}[${seriesArrayForIdent(node.args[0])}.length - 2]`;
      const bPrev = `/* prev */ ${seriesArrayForIdent(node.args[1])}[${seriesArrayForIdent(node.args[1])}.length - 2]`;
      return `${fn}(${a}, ${b}, ${aPrev}, ${bPrev})`;
    }
    default:
      return `/* TODO ${node.callee} */ NaN`;
  }
}

function seriesArrayForIdent(node) {
  if (!node || node.type !== 'Ident') return 'closes';
  switch (node.name) {
    case 'open':
      return 'candles.map((c) => c.open)';
    case 'high':
      return 'highs';
    case 'low':
      return 'lows';
    case 'close':
      return 'closes';
    case 'volume':
      return 'volumes';
    default:
      // User-assigned identifiers are TODOs — they'd need their own array form.
      return `/* TODO user series ${node.name} */ closes`;
  }
}

function constLit(node) {
  if (!node) return '0';
  if (node.type === 'Number') return String(node.value);
  if (node.type === 'String') return JSON.stringify(node.value);
  if (node.type === 'Bool') return node.value ? 'true' : 'false';
  return '0';
}

function identFromName(name) {
  let s = String(name || 'Strategy').replace(/[^a-zA-Z0-9]+/g, '');
  if (!s) s = 'Strategy';
  if (!/^[A-Za-z]/.test(s)) s = 'S' + s;
  return s[0].toUpperCase() + s.slice(1);
}

function kebab(s) {
  return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
