// Incremental, stateful TA primitives consumed by the script-facing TA layer.
// Semantics match src/strategy/indicators.ts so the golden test can hold one-to-one
// over the same input candles.

export class EmaState {
  readonly period: number;
  readonly k: number;
  private n = 0;
  private seedSum = 0;
  value = NaN;

  constructor(period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`EMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.k = 2 / (period + 1);
  }

  update(x: number): number {
    if (!Number.isFinite(x)) {
      this.n += 1;
      return this.value;
    }
    this.n += 1;
    if (this.n < this.period) {
      this.seedSum += x;
      return NaN;
    }
    if (this.n === this.period) {
      this.seedSum += x;
      this.value = this.seedSum / this.period;
      return this.value;
    }
    this.value = x * this.k + this.value * (1 - this.k);
    return this.value;
  }
}

export class RsiState {
  readonly period: number;
  private n = 0;
  private prev = NaN;
  private gainSum = 0;
  private lossSum = 0;
  private avgGain = NaN;
  private avgLoss = NaN;
  value = NaN;

  constructor(period = 14) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`RSI period must be a positive integer (got ${period})`);
    }
    this.period = period;
  }

  update(x: number): number {
    if (!Number.isFinite(x)) {
      this.n += 1;
      return this.value;
    }
    const idx = this.n;
    this.n += 1;
    if (idx === 0) {
      this.prev = x;
      return NaN;
    }
    const diff = x - this.prev;
    this.prev = x;
    if (idx <= this.period) {
      if (diff >= 0) this.gainSum += diff;
      else this.lossSum -= diff;
      if (idx === this.period) {
        this.avgGain = this.gainSum / this.period;
        this.avgLoss = this.lossSum / this.period;
        this.value =
          this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
        return this.value;
      }
      return NaN;
    }
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    this.avgGain = (this.avgGain * (this.period - 1) + gain) / this.period;
    this.avgLoss = (this.avgLoss * (this.period - 1) + loss) / this.period;
    this.value =
      this.avgLoss === 0 ? 100 : 100 - 100 / (1 + this.avgGain / this.avgLoss);
    return this.value;
  }
}

export class SmaState {
  readonly period: number;
  private readonly window: Float64Array;
  private idx = 0;
  private n = 0;
  private sum = 0;
  value = NaN;

  constructor(period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`SMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
  }

  update(x: number): number {
    const v = Number.isFinite(x) ? x : 0;
    if (this.n < this.period) {
      this.window[this.idx] = v;
      this.sum += v;
      this.idx = (this.idx + 1) % this.period;
      this.n += 1;
      if (this.n === this.period) {
        this.value = this.sum / this.period;
        return this.value;
      }
      return NaN;
    }
    this.sum += v - this.window[this.idx]!;
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    this.value = this.sum / this.period;
    return this.value;
  }
}

export class AtrState {
  readonly period: number;
  private n = 0;
  private prevClose = NaN;
  private trSum = 0;
  value = NaN;

  constructor(period = 14) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`ATR period must be a positive integer (got ${period})`);
    }
    this.period = period;
  }

  update(high: number, low: number, close: number): number {
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      this.n += 1;
      return this.value;
    }
    let tr: number;
    if (this.n === 0) {
      tr = high - low;
    } else {
      tr = Math.max(
        high - low,
        Math.abs(high - this.prevClose),
        Math.abs(low - this.prevClose),
      );
    }
    this.prevClose = close;
    const idx = this.n;
    this.n += 1;
    if (idx < this.period - 1) {
      this.trSum += tr;
      return NaN;
    }
    if (idx === this.period - 1) {
      this.trSum += tr;
      this.value = this.trSum / this.period;
      return this.value;
    }
    this.value = (this.value * (this.period - 1) + tr) / this.period;
    return this.value;
  }
}

export class StdevState {
  readonly period: number;
  private readonly window: Float64Array;
  private idx = 0;
  private n = 0;
  value = NaN;

  constructor(period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Stdev period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
  }

  update(x: number): number {
    const v = Number.isFinite(x) ? x : 0;
    if (this.n < this.period) {
      this.window[this.idx] = v;
      this.idx = (this.idx + 1) % this.period;
      this.n += 1;
      if (this.n < this.period) return NaN;
    } else {
      this.window[this.idx] = v;
      this.idx = (this.idx + 1) % this.period;
    }
    let mean = 0;
    for (let i = 0; i < this.period; i++) mean += this.window[i]!;
    mean /= this.period;
    let sq = 0;
    for (let i = 0; i < this.period; i++) {
      const d = this.window[i]! - mean;
      sq += d * d;
    }
    this.value = Math.sqrt(sq / this.period);
    return this.value;
  }
}

export class SumState {
  readonly period: number;
  private readonly window: Float64Array;
  private idx = 0;
  private n = 0;
  private sum = 0;
  value = NaN;

  constructor(period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Sum period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
  }

  update(x: number): number {
    const v = Number.isFinite(x) ? x : 0;
    if (this.n < this.period) {
      this.window[this.idx] = v;
      this.sum += v;
      this.idx = (this.idx + 1) % this.period;
      this.n += 1;
      if (this.n === this.period) {
        this.value = this.sum;
        return this.value;
      }
      return NaN;
    }
    this.sum += v - this.window[this.idx]!;
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    this.value = this.sum;
    return this.value;
  }
}

export class WmaState {
  readonly period: number;
  private readonly window: Float64Array;
  private idx = 0;
  private n = 0;
  private readonly denom: number;
  value = NaN;

  constructor(period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`WMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
    this.denom = (period * (period + 1)) / 2;
  }

  update(x: number): number {
    const v = Number.isFinite(x) ? x : 0;
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    if (this.n < this.period) this.n += 1;
    if (this.n < this.period) return NaN;
    let num = 0;
    let weight = 1;
    let cursor = this.idx;
    for (let i = 0; i < this.period; i++) {
      num += this.window[cursor]! * weight;
      weight += 1;
      cursor = (cursor + 1) % this.period;
    }
    this.value = num / this.denom;
    return this.value;
  }
}

export class VwmaState {
  readonly period: number;
  private readonly vals: Float64Array;
  private readonly vols: Float64Array;
  private idx = 0;
  private n = 0;
  private numSum = 0;
  private volSum = 0;
  value = NaN;

  constructor(period: number) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`VWMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.vals = new Float64Array(period);
    this.vols = new Float64Array(period);
  }

  update(price: number, volume: number): number {
    const p = Number.isFinite(price) ? price : 0;
    const v = Number.isFinite(volume) ? volume : 0;
    if (this.n < this.period) {
      this.vals[this.idx] = p;
      this.vols[this.idx] = v;
      this.numSum += p * v;
      this.volSum += v;
      this.idx = (this.idx + 1) % this.period;
      this.n += 1;
      if (this.n === this.period) {
        this.value = this.volSum === 0 ? NaN : this.numSum / this.volSum;
        return this.value;
      }
      return NaN;
    }
    this.numSum += p * v - this.vals[this.idx]! * this.vols[this.idx]!;
    this.volSum += v - this.vols[this.idx]!;
    this.vals[this.idx] = p;
    this.vols[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    this.value = this.volSum === 0 ? NaN : this.numSum / this.volSum;
    return this.value;
  }
}

export class MacdState {
  readonly fast: number;
  readonly slow: number;
  readonly signal: number;
  private readonly fastEma: EmaState;
  private readonly slowEma: EmaState;
  private readonly signalEma: EmaState;
  macd = NaN;
  signalValue = NaN;
  hist = NaN;

  constructor(fast: number, slow: number, signal: number) {
    if (!Number.isInteger(fast) || fast <= 0) {
      throw new RangeError(`MACD fast period must be a positive integer (got ${fast})`);
    }
    if (!Number.isInteger(slow) || slow <= 0) {
      throw new RangeError(`MACD slow period must be a positive integer (got ${slow})`);
    }
    if (!Number.isInteger(signal) || signal <= 0) {
      throw new RangeError(`MACD signal period must be a positive integer (got ${signal})`);
    }
    this.fast = fast;
    this.slow = slow;
    this.signal = signal;
    this.fastEma = new EmaState(fast);
    this.slowEma = new EmaState(slow);
    this.signalEma = new EmaState(signal);
  }

  update(x: number): { macd: number; signal: number; hist: number } {
    const fast = this.fastEma.update(x);
    const slow = this.slowEma.update(x);
    this.macd = Number.isFinite(fast) && Number.isFinite(slow) ? fast - slow : NaN;
    this.signalValue = this.signalEma.update(this.macd);
    this.hist =
      Number.isFinite(this.macd) && Number.isFinite(this.signalValue)
        ? this.macd - this.signalValue
        : NaN;
    return { macd: this.macd, signal: this.signalValue, hist: this.hist };
  }
}

export class TrendState {
  readonly period: number;
  readonly mode: 'falling' | 'rising';
  private readonly window: Float64Array;
  private idx = 0;
  private n = 0;

  constructor(period: number, mode: 'falling' | 'rising') {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Period must be a positive integer (got ${period})`);
    }
    if (mode !== 'falling' && mode !== 'rising') {
      throw new RangeError(`mode must be 'falling' or 'rising' (got ${mode})`);
    }
    this.period = period;
    this.mode = mode;
    this.window = new Float64Array(period + 1);
  }

  update(x: number): boolean {
    const v = Number.isFinite(x) ? x : NaN;
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % (this.period + 1);
    if (this.n <= this.period) this.n += 1;
    if (this.n <= this.period) return false;
    let cursor = this.idx;
    let prev = this.window[cursor]!;
    cursor = (cursor + 1) % (this.period + 1);
    for (let i = 0; i < this.period; i++) {
      const cur = this.window[cursor]!;
      if (this.mode === 'falling' && !(cur < prev)) return false;
      if (this.mode === 'rising' && !(cur > prev)) return false;
      prev = cur;
      cursor = (cursor + 1) % (this.period + 1);
    }
    return true;
  }
}

interface DequeEntry {
  idx: number;
  value: number;
}

export class RollingExtreme {
  readonly period: number;
  readonly mode: 'max' | 'min';
  private n = 0;
  private readonly deque: DequeEntry[] = [];

  constructor(period: number, mode: 'max' | 'min') {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Period must be a positive integer (got ${period})`);
    }
    if (mode !== 'max' && mode !== 'min') {
      throw new RangeError(`mode must be 'max' or 'min' (got ${mode})`);
    }
    this.period = period;
    this.mode = mode;
  }

  update(x: number): number {
    const idx = this.n;
    this.n += 1;
    if (!Number.isFinite(x)) return this.peek();
    while (this.deque.length && this.deque[0]!.idx <= idx - this.period) {
      this.deque.shift();
    }
    if (this.mode === 'max') {
      while (this.deque.length && this.deque[this.deque.length - 1]!.value <= x) {
        this.deque.pop();
      }
    } else {
      while (this.deque.length && this.deque[this.deque.length - 1]!.value >= x) {
        this.deque.pop();
      }
    }
    this.deque.push({ idx, value: x });
    if (idx < this.period - 1) return NaN;
    return this.deque[0]!.value;
  }

  peek(): number {
    if (this.n < this.period || this.deque.length === 0) return NaN;
    return this.deque[0]!.value;
  }
}
