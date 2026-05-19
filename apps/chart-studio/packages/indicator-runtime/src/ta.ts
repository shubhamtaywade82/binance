// Script-facing TA call surface.
//
// Every TA call site is keyed by AST node identity so that its incremental state
// (EmaState / RsiState / etc.) survives between bars. The interpreter passes the
// AST node + the current Series argument; this module owns the keyed cache.

import { RuntimeError, ValidationError } from './errors.js';
import { Series, DEFAULT_SERIES_CAPACITY } from './series.js';
import type { ExecutionContext } from './context.js';
import type { Expr, KwArg } from './nodes.js';
import {
  EmaState,
  RsiState,
  SmaState,
  AtrState,
  RollingExtreme,
  StdevState,
  SumState,
  WmaState,
  VwmaState,
  TrendState,
  MacdState,
} from './ta-core.js';

const MAX_LEN = DEFAULT_SERIES_CAPACITY;

type CallExpr = Extract<Expr, { type: 'Call' }>;

interface SecurityCallState {
  tf: string;
  srcName: string;
  series: Series;
}

class NanoArray {
  readonly items: unknown[] = [];
}
class NanoMap {
  readonly items = new Map<string, unknown>();
}

function kwargsToMap(kwargs: KwArg[], evaluator: (e: Expr) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kw of kwargs) out[kw.name] = evaluator(kw.value);
  return out;
}

function asNumber(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RuntimeError(`Argument '${name}' must be a finite number (got ${v})`);
  }
  return v;
}

function asInt(v: unknown, name: string): number {
  const n = asNumber(v, name);
  if (!Number.isInteger(n)) {
    throw new RuntimeError(`Argument '${name}' must be an integer (got ${n})`);
  }
  return n;
}

function asPeriod(v: unknown, name: string): number {
  const n = asInt(v, name);
  if (n <= 0) throw new RuntimeError(`Argument '${name}' must be > 0 (got ${n})`);
  if (n > MAX_LEN) {
    throw new RuntimeError(`Argument '${name}' exceeds max length ${MAX_LEN} (got ${n})`);
  }
  return n;
}

function asSeries(v: unknown, name: string): Series {
  if (!(v instanceof Series)) {
    throw new RuntimeError(`Argument '${name}' must be a series`);
  }
  return v;
}

function asNumberOrSeriesNow(v: unknown, name: string): number {
  if (v instanceof Series) return v.get(0);
  return asNumber(v, name);
}

function asBool(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (v instanceof Series) {
    const x = v.get(0);
    return Number.isFinite(x) && x !== 0;
  }
  return Boolean(v);
}
function asArray(v: unknown, name: string): NanoArray {
  if (!(v instanceof NanoArray)) throw new RuntimeError(`Argument '${name}' must be an array`);
  return v;
}
function asMap(v: unknown, name: string): NanoMap {
  if (!(v instanceof NanoMap)) throw new RuntimeError(`Argument '${name}' must be a map`);
  return v;
}

function toColor(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? `#${Math.trunc(v).toString(16)}` : null;
  return null;
}

function getCallState<T extends object>(ctx: ExecutionContext, node: object, factory: () => T): T {
  let s = ctx.callState.get(node) as T | undefined;
  if (!s) {
    s = factory();
    ctx.callState.set(node, s);
  }
  return s;
}

export type BuiltinHandler = (
  ctx: ExecutionContext,
  node: CallExpr,
  args: unknown[],
  kwargs: KwArg[],
  evaluator: (e: Expr) => unknown,
) => unknown;

export const BUILTINS: Record<string, BuiltinHandler> = {
  sma(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new SmaState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `sma(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  ema(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new EmaState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `ema(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  rsi(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new RsiState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `rsi(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  atr(ctx, node, args) {
    const len = asPeriod(args[0], 'len');
    const state = getCallState(ctx, node, () => new AtrState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `atr(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    const high = ctx.builtins.high.get(0);
    const low = ctx.builtins.low.get(0);
    const close = ctx.builtins.close.get(0);
    return state.update(high, low, close);
  },

  highest(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new RollingExtreme(len, 'max'));
    if (state.period !== len) {
      throw new ValidationError(
        `highest(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  lowest(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new RollingExtreme(len, 'min'));
    if (state.period !== len) {
      throw new ValidationError(
        `lowest(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  stdev(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new StdevState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `stdev(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  sum(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new SumState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `sum(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  wma(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new WmaState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `wma(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  vwma(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new VwmaState(len));
    if (state.period !== len) {
      throw new ValidationError(
        `vwma(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0), ctx.builtins.volume.get(0));
  },

  falling(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new TrendState(len, 'falling'));
    if (state.period !== len) {
      throw new ValidationError(
        `falling(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  rising(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => new TrendState(len, 'rising'));
    if (state.period !== len) {
      throw new ValidationError(
        `rising(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    return state.update(src.get(0));
  },

  crossover(_ctx, _node, args) {
    const [a, b] = args as [unknown, unknown];
    if (a instanceof Series && b instanceof Series) {
      return a.get(0) > b.get(0) && a.get(1) <= b.get(1);
    }
    const a0 = a instanceof Series ? a.get(0) : asNumber(a, 'a');
    const a1 = a instanceof Series ? a.get(1) : asNumber(a, 'a');
    const b0 = b instanceof Series ? b.get(0) : asNumber(b, 'b');
    const b1 = b instanceof Series ? b.get(1) : asNumber(b, 'b');
    return a0 > b0 && a1 <= b1;
  },

  crossunder(_ctx, _node, args) {
    const [a, b] = args as [unknown, unknown];
    const a0 = a instanceof Series ? a.get(0) : asNumber(a, 'a');
    const a1 = a instanceof Series ? a.get(1) : asNumber(a, 'a');
    const b0 = b instanceof Series ? b.get(0) : asNumber(b, 'b');
    const b1 = b instanceof Series ? b.get(1) : asNumber(b, 'b');
    return a0 < b0 && a1 >= b1;
  },

  change(_ctx, _node, args) {
    const src = asSeries(args[0], 'src');
    return src.get(0) - src.get(1);
  },

  nz(_ctx, _node, args) {
    const v = args[0];
    const fb = args.length > 1 ? args[1] : 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) return fb as number;
    return v;
  },

  na(_ctx, _node, args) {
    const v = args[0];
    return typeof v === 'number' ? Number.isNaN(v) : v === null || v === undefined;
  },

  abs(_ctx, _node, args) {
    return Math.abs(asNumber(args[0], 'x'));
  },

  max(_ctx, _node, args) {
    return Math.max(asNumber(args[0], 'a'), asNumber(args[1], 'b'));
  },

  min(_ctx, _node, args) {
    return Math.min(asNumber(args[0], 'a'), asNumber(args[1], 'b'));
  },

  color(_ctx, _node, args) {
    const r = Math.max(0, Math.min(255, Math.round(asNumber(args[0], 'r'))));
    const g = Math.max(0, Math.min(255, Math.round(asNumber(args[1], 'g'))));
    const b = Math.max(0, Math.min(255, Math.round(asNumber(args[2], 'b'))));
    const aRaw = args.length >= 4 ? asNumber(args[3], 'a') : 1;
    const a = Math.max(0, Math.min(1, aRaw));
    if (a >= 0.999) return `rgb(${r},${g},${b})`;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
  },
  array_new() {
    return new NanoArray();
  },
  array_push(_ctx, _node, args) {
    const arr = asArray(args[0], 'arr');
    arr.items.push(args[1]);
    return arr.items.length;
  },
  array_get(_ctx, _node, args) {
    const arr = asArray(args[0], 'arr');
    const idx = asInt(args[1], 'idx');
    if (idx < 0 || idx >= arr.items.length) return NaN;
    return arr.items[idx];
  },
  array_set(_ctx, _node, args) {
    const arr = asArray(args[0], 'arr');
    const idx = asInt(args[1], 'idx');
    if (idx < 0) throw new RuntimeError(`array_set(): idx must be >= 0 (got ${idx})`);
    arr.items[idx] = args[2];
    return args[2];
  },
  array_size(_ctx, _node, args) {
    return asArray(args[0], 'arr').items.length;
  },
  map_new() {
    return new NanoMap();
  },
  map_set(_ctx, _node, args) {
    const m = asMap(args[0], 'map');
    const k = String(args[1]);
    m.items.set(k, args[2]);
    return true;
  },
  map_get(_ctx, _node, args) {
    const m = asMap(args[0], 'map');
    const k = String(args[1]);
    if (!m.items.has(k)) return args.length >= 3 ? args[2] : NaN;
    return m.items.get(k);
  },
  map_has(_ctx, _node, args) {
    const m = asMap(args[0], 'map');
    return m.items.has(String(args[1]));
  },
  map_size(_ctx, _node, args) {
    return asMap(args[0], 'map').items.size;
  },

  mom(_ctx, _node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    return src.get(0) - src.get(len);
  },

  roc(_ctx, _node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const prev = src.get(len);
    if (!Number.isFinite(prev) || prev === 0) return NaN;
    return ((src.get(0) - prev) / prev) * 100;
  },

  bbmiddle(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const state = getCallState(ctx, node, () => ({
      sma: new SmaState(len),
      stdev: new StdevState(len),
      period: len,
    }));
    if (state.period !== len) {
      throw new ValidationError(
        `bbmiddle(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    state.stdev.update(src.get(0));
    return state.sma.update(src.get(0));
  },

  bbupper(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const mult = asNumber(args[2], 'mult');
    const state = getCallState(ctx, node, () => ({
      sma: new SmaState(len),
      stdev: new StdevState(len),
      period: len,
    }));
    if (state.period !== len) {
      throw new ValidationError(
        `bbupper(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    const basis = state.sma.update(src.get(0));
    const dev = state.stdev.update(src.get(0));
    return Number.isFinite(basis) && Number.isFinite(dev) ? basis + mult * dev : NaN;
  },

  bblower(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const len = asPeriod(args[1], 'len');
    const mult = asNumber(args[2], 'mult');
    const state = getCallState(ctx, node, () => ({
      sma: new SmaState(len),
      stdev: new StdevState(len),
      period: len,
    }));
    if (state.period !== len) {
      throw new ValidationError(
        `bblower(): 'len' must be constant per call site (was ${state.period}, got ${len})`,
      );
    }
    const basis = state.sma.update(src.get(0));
    const dev = state.stdev.update(src.get(0));
    return Number.isFinite(basis) && Number.isFinite(dev) ? basis - mult * dev : NaN;
  },

  macd(ctx, node, args) {
    const src = asSeries(args[0], 'src');
    const fast = asPeriod(args[1], 'fast');
    const slow = asPeriod(args[2], 'slow');
    const signal = asPeriod(args[3], 'signal');
    const part = String(args[4] ?? 'macd').toLowerCase();
    if (part !== 'macd' && part !== 'signal' && part !== 'hist') {
      throw new RuntimeError(`macd(): part must be "macd", "signal", or "hist" (got ${part})`);
    }
    const state = getCallState(ctx, node, () => new MacdState(fast, slow, signal));
    if (state.fast !== fast || state.slow !== slow || state.signal !== signal) {
      throw new ValidationError(
        `macd(): periods must be constant per call site (was ${state.fast}/${state.slow}/${state.signal}, got ${fast}/${slow}/${signal})`,
      );
    }
    const out = state.update(src.get(0));
    if (part === 'signal') return out.signal;
    if (part === 'hist') return out.hist;
    return out.macd;
  },

  plot(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('plot() requires at least one argument');
    }
    const value = args[0];
    const num =
      typeof value === 'number' ? value : value instanceof Series ? value.get(0) : NaN;
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const positional: Record<string, unknown> = {};
    if (args.length >= 2 && typeof args[1] === 'string') positional.color = args[1];
    if (args.length >= 3 && typeof args[2] === 'number') positional.lineWidth = args[2];
    if (args.length >= 4 && typeof args[3] === 'string') positional.title = args[3];
    const opts: Record<string, unknown> = { ...positional, ...optsFromKw };
    const style = typeof opts.style === 'string' ? opts.style : 'line';
    const kind = style === 'histogram' ? 'histogram' : style === 'area' ? 'area' : 'line';
    if (!('pane' in opts) && ctx.meta?.opts?.overlay === false) opts.pane = 1;
    ctx.emitPlot(node, kind, num, opts);
    return num;
  },

  alert(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('alert() requires at least one argument');
    }
    const cond = asBool(args[0]);
    if (!cond) return false;
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const message =
      (args.length >= 2 && typeof args[1] === 'string' && args[1]) ||
      (optsFromKw.message as string) ||
      (optsFromKw.title as string) ||
      `Alert at bar ${ctx.barIndex}`;
    ctx.emitAlert(node, String(message), optsFromKw);
    return true;
  },

  plotshape(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('plotshape() requires at least one argument');
    }
    const cond = asBool(args[0]);
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const positional: Record<string, unknown> = {};
    if (args.length >= 2 && typeof args[1] === 'string') positional.location = args[1];
    if (args.length >= 3 && typeof args[2] === 'string') positional.color = args[2];
    if (args.length >= 4 && typeof args[3] === 'string') positional.shape = args[3];
    if (args.length >= 5 && typeof args[4] === 'string') positional.title = args[4];
    const opts = { ...positional, ...optsFromKw };
    ctx.emitShape(node, cond, opts);
    return cond;
  },

  hline(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('hline() requires at least one argument');
    }
    const price = asNumber(args[0], 'price');
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const positional: Record<string, unknown> = {};
    if (args.length >= 2 && typeof args[1] === 'string') positional.color = args[1];
    if (args.length >= 3 && typeof args[2] === 'string') positional.title = args[2];
    const opts = { ...positional, ...optsFromKw };
    ctx.emitHLine(node, price, opts);
    return price;
  },

  security(ctx, node, args) {
    if (args.length < 2) {
      throw new RuntimeError('security(tf, srcName) requires both arguments');
    }
    const tf = String(args[0]);
    const srcName = String(args[1]);
    const allowed = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4']);
    if (!allowed.has(srcName)) {
      throw new RuntimeError(
        `security(): srcName must be one of open/high/low/close/volume/hl2/hlc3/ohlc4 (got "${srcName}")`,
      );
    }
    let state = ctx.callState.get(node) as SecurityCallState | undefined;
    if (!state) {
      state = { tf, srcName, series: new Series(ctx.capacity) };
      ctx.callState.set(node, state);
    }
    if (state.tf !== tf || state.srcName !== srcName) {
      throw new ValidationError(
        `security(): tf and srcName must be constant per call site (was ${state.tf}/${state.srcName}, got ${tf}/${srcName})`,
      );
    }
    const v = ctx.lookupHtfValue(tf, srcName);
    state.series.push(v);
    return state.series;
  },

  entry(ctx, _node, args, kwargs, evaluator) {
    if (args.length < 2) {
      throw new RuntimeError('entry(cond, side, qty?) requires cond and side');
    }
    const cond = asBool(args[0]);
    const side = String(args[1] || '').toLowerCase();
    if (side !== 'long' && side !== 'short') {
      throw new RuntimeError(`entry(): side must be "long" or "short" (got ${args[1]})`);
    }
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    // Forward sizing kwargs to the context. Positional `qty` (third positional arg)
    // still works in fixed-sizing mode.
    const opts: Record<string, unknown> = { ...optsFromKw };
    if (args.length >= 3 && Number.isFinite(args[2] as number)) {
      opts.qty = args[2];
    }
    const allowed = new Set(['fixed', 'cash', 'pct_equity', 'risk']);
    if (opts.sizing != null && !allowed.has(String(opts.sizing))) {
      throw new RuntimeError(
        `entry(): sizing must be one of fixed/cash/pct_equity/risk (got ${opts.sizing})`,
      );
    }
    ctx.strategyOrder(side as 'long' | 'short', cond, opts);
    return cond;
  },

  exit(ctx, _node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('exit(cond) requires a condition');
    }
    const cond = asBool(args[0]);
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    ctx.strategyOrder('flat', cond, optsFromKw);
    return cond;
  },

  bgcolor(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('bgcolor() requires at least one argument');
    }
    const color = typeof args[0] === 'string' ? args[0] : null;
    const opacity = args.length >= 2 && typeof args[1] === 'number' ? args[1] : 0.2;
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    ctx.emitBgColor(node, color, { opacity, ...optsFromKw });
    return color;
  },

  label(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) throw new RuntimeError('label(cond, ...) requires condition');
    const cond = asBool(args[0]);
    if (!cond) return false;
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const text = typeof args[1] === 'string' ? args[1] : String(optsFromKw.text ?? '');
    const location = typeof args[2] === 'string' ? args[2] : String(optsFromKw.location ?? 'abovebar');
    const color = toColor(args[3] ?? optsFromKw.color) ?? '#42a5f5';
    const textcolor = toColor(args[4] ?? optsFromKw.textcolor) ?? '#ffffff';
    ctx.emitShape(node, true, { ...optsFromKw, title: text || optsFromKw.title, location, color, textcolor, shape: 'label' });
    return true;
  },

  line(ctx, node, args, kwargs, evaluator) {
    if (args.length < 2) throw new RuntimeError('line(cond, price, ...) requires condition and price');
    const cond = asBool(args[0]);
    if (!cond) return false;
    const price = asNumberOrSeriesNow(args[1], 'price');
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const color = toColor(args[2] ?? optsFromKw.color);
    const title = typeof args[3] === 'string' ? args[3] : optsFromKw.title;
    ctx.emitHLine(node, price, { ...optsFromKw, ...(color ? { color } : {}), ...(title ? { title } : {}) });
    return true;
  },
};

export function isBuiltin(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTINS, name);
}
