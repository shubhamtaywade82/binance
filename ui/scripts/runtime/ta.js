// Script-facing TA call surface.
//
// Every TA call site is keyed by AST node identity so that its incremental state
// (EmaState / RsiState / etc.) survives between bars. The interpreter passes the
// AST node + the current Series argument; this module owns the keyed cache.
//
// Plots and shapes are not TA — they're emitted via ExecutionContext.emitPlot /
// emitShape — but the call dispatch lives here so the interpreter has a single
// `callBuiltin(ctx, callNode, evaluatedArgs, kwargs)` entrypoint.

import { RuntimeError, ValidationError } from './errors.js';
import { Series, DEFAULT_SERIES_CAPACITY } from './series.js';
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
} from './ta-core.js';

const MAX_LEN = DEFAULT_SERIES_CAPACITY;

// kwargsToMap: { color, lineWidth, title, ... } from KwArg[].
function kwargsToMap(kwargs, evaluator) {
  const out = {};
  for (const kw of kwargs) out[kw.name] = evaluator(kw.value);
  return out;
}

function asNumber(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RuntimeError(`Argument '${name}' must be a finite number (got ${v})`);
  }
  return v;
}

function asInt(v, name) {
  const n = asNumber(v, name);
  if (!Number.isInteger(n)) {
    throw new RuntimeError(`Argument '${name}' must be an integer (got ${n})`);
  }
  return n;
}

function asPeriod(v, name) {
  const n = asInt(v, name);
  if (n <= 0) throw new RuntimeError(`Argument '${name}' must be > 0 (got ${n})`);
  if (n > MAX_LEN) {
    throw new RuntimeError(`Argument '${name}' exceeds max length ${MAX_LEN} (got ${n})`);
  }
  return n;
}

function asSeries(v, name) {
  if (!(v instanceof Series)) {
    throw new RuntimeError(`Argument '${name}' must be a series`);
  }
  return v;
}

function asBool(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (v instanceof Series) {
    const x = v.get(0);
    return Number.isFinite(x) && x !== 0;
  }
  return false;
}

// Per-call-site cache lookup. `ctx.callState` is a WeakMap keyed by AST Call nodes.
function getCallState(ctx, node, factory) {
  let s = ctx.callState.get(node);
  if (!s) {
    s = factory();
    ctx.callState.set(node, s);
  }
  return s;
}

// BUILTINS table: name → handler(ctx, callNode, args, kwargs, evaluator)
// where `args` is an array of already-evaluated values and `kwargs` is the KwArg[].
export const BUILTINS = {
  // -- TA: moving averages and oscillators -------------------------------------
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

  // -- Cross detection ---------------------------------------------------------
  crossover(_ctx, _node, args) {
    const [a, b] = args;
    if (a instanceof Series && b instanceof Series) {
      return a.get(0) > b.get(0) && a.get(1) <= b.get(1);
    }
    // Scalars passed in: caller should compare currents/previous explicitly. For MVP
    // crossover only meaningfully works when at least one side is a Series — we accept
    // mixed Series/scalar by treating scalar as constant series.
    const a0 = a instanceof Series ? a.get(0) : asNumber(a, 'a');
    const a1 = a instanceof Series ? a.get(1) : asNumber(a, 'a');
    const b0 = b instanceof Series ? b.get(0) : asNumber(b, 'b');
    const b1 = b instanceof Series ? b.get(1) : asNumber(b, 'b');
    return a0 > b0 && a1 <= b1;
  },

  crossunder(_ctx, _node, args) {
    const [a, b] = args;
    const a0 = a instanceof Series ? a.get(0) : asNumber(a, 'a');
    const a1 = a instanceof Series ? a.get(1) : asNumber(a, 'a');
    const b0 = b instanceof Series ? b.get(0) : asNumber(b, 'b');
    const b1 = b instanceof Series ? b.get(1) : asNumber(b, 'b');
    return a0 < b0 && a1 >= b1;
  },

  // -- Utility -----------------------------------------------------------------
  change(_ctx, _node, args) {
    const src = asSeries(args[0], 'src');
    return src.get(0) - src.get(1);
  },

  nz(_ctx, _node, args) {
    const v = args[0];
    const fb = args.length > 1 ? args[1] : 0;
    if (typeof v !== 'number' || !Number.isFinite(v)) return fb;
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

  // -- Output emitters ---------------------------------------------------------
  // plot(value, color?, lineWidth?, title?, style="line"|"histogram"|"area", pane=0)
  plot(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('plot() requires at least one argument');
    }
    const value = args[0];
    const num = typeof value === 'number' ? value : value instanceof Series ? value.get(0) : NaN;
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const positional = {};
    if (args.length >= 2 && typeof args[1] === 'string') positional.color = args[1];
    if (args.length >= 3 && typeof args[2] === 'number') positional.lineWidth = args[2];
    if (args.length >= 4 && typeof args[3] === 'string') positional.title = args[3];
    const opts = { ...positional, ...optsFromKw };
    const style = typeof opts.style === 'string' ? opts.style : 'line';
    const kind =
      style === 'histogram' ? 'histogram' : style === 'area' ? 'area' : 'line';
    if (!('pane' in opts) && ctx.meta?.opts?.overlay === false) opts.pane = 1;
    ctx.emitPlot(node, kind, num, opts);
    return num;
  },

  // alert(cond, message?) — emits an alert event whenever cond is truthy.
  // Browser-side notifications are surfaced by the main thread.
  alert(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('alert() requires at least one argument');
    }
    const cond = asBool(args[0]);
    if (!cond) return false;
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const message =
      (args.length >= 2 && typeof args[1] === 'string' && args[1]) ||
      optsFromKw.message ||
      optsFromKw.title ||
      `Alert at bar ${ctx.barIndex}`;
    ctx.emitAlert(node, String(message), optsFromKw);
    return true;
  },

  // plotshape(cond, location?, color?, shape?, title?)
  plotshape(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('plotshape() requires at least one argument');
    }
    const cond = asBool(args[0]);
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const positional = {};
    if (args.length >= 2 && typeof args[1] === 'string') positional.location = args[1];
    if (args.length >= 3 && typeof args[2] === 'string') positional.color = args[2];
    if (args.length >= 4 && typeof args[3] === 'string') positional.shape = args[3];
    if (args.length >= 5 && typeof args[4] === 'string') positional.title = args[4];
    const opts = { ...positional, ...optsFromKw };
    ctx.emitShape(node, cond, opts);
    return cond;
  },

  // hline(price, color?, title?, lineStyle?)
  hline(ctx, node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('hline() requires at least one argument');
    }
    const price = asNumber(args[0], 'price');
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    const positional = {};
    if (args.length >= 2 && typeof args[1] === 'string') positional.color = args[1];
    if (args.length >= 3 && typeof args[2] === 'string') positional.title = args[2];
    const opts = { ...positional, ...optsFromKw };
    ctx.emitHLine(node, price, opts);
    return price;
  },

  // security(tf, srcName) — fetch a builtin source value (close/open/high/low/volume/
  // hl2/hlc3/ohlc4) from a higher timeframe at the most recently closed bar (no
  // lookahead). Returns NaN until at least one higher-TF bar has fully closed within
  // the script's history window.
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
    // Cache a per-call-site Series so `security("1h","close")[k]` works for k bars ago.
    let state = ctx.callState.get(node);
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

  // entry(cond, side, qty=1) — long/short entry at current bar's close.
  // Calling entry while an opposite-side position is open auto-reverses (closes
  // the existing position at the same bar's close, then opens the new one).
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
    const qty = args.length >= 3 && Number.isFinite(args[2]) ? args[2] : optsFromKw.qty ?? 1;
    ctx.strategyOrder(side, cond, { qty });
    return cond;
  },

  // exit(cond) — close any open position at current bar's close.
  exit(ctx, _node, args, kwargs, evaluator) {
    if (args.length < 1) {
      throw new RuntimeError('exit(cond) requires a condition');
    }
    const cond = asBool(args[0]);
    const optsFromKw = kwargsToMap(kwargs, evaluator);
    ctx.strategyOrder('flat', cond, optsFromKw);
    return cond;
  },

  // bgcolor(color, opacity?)
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
};

export function isBuiltin(name) {
  return Object.prototype.hasOwnProperty.call(BUILTINS, name);
}
