// Incremental, stateful TA primitives consumed by the script-facing TA layer.
// Semantics match src/strategy/indicators.ts so the golden test can hold one-to-one
// over the same input candles.

export class EmaState {
  constructor(period) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`EMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.k = 2 / (period + 1);
    this.n = 0;
    this.seedSum = 0;
    this.value = NaN;
  }

  // Returns the current EMA value, or NaN during warmup (n < period).
  update(x) {
    if (!Number.isFinite(x)) {
      // Treat non-finite inputs as no-op (still advance n? indicators.ts treats every bar
      // as a sample regardless; here we keep parity and increment).
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

// Wilder-smoothed RSI matching src/strategy/indicators.ts exactly.
export class RsiState {
  constructor(period = 14) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`RSI period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.n = 0;
    this.prev = NaN;
    this.gainSum = 0;
    this.lossSum = 0;
    this.avgGain = NaN;
    this.avgLoss = NaN;
    this.value = NaN;
  }

  update(x) {
    if (!Number.isFinite(x)) {
      this.n += 1;
      return this.value;
    }
    const idx = this.n; // 0-based index of this sample
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

// Simple moving average via rolling sum.
export class SmaState {
  constructor(period) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`SMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
    this.idx = 0;
    this.n = 0;
    this.sum = 0;
    this.value = NaN;
  }

  update(x) {
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
    this.sum += v - this.window[this.idx];
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    this.value = this.sum / this.period;
    return this.value;
  }
}

// ATR matching src/strategy/indicators.ts exactly: SMA of TR over first `period` bars,
// then Wilder smoothing.
export class AtrState {
  constructor(period = 14) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`ATR period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.n = 0;
    this.prevClose = NaN;
    this.trSum = 0;
    this.value = NaN;
  }

  update(high, low, close) {
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      this.n += 1;
      return this.value;
    }
    let tr;
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

// Rolling-window standard deviation using Welford's algorithm restarted each window.
// Matches Pine's ta.stdev(): population standard deviation (divide by N, not N-1).
export class StdevState {
  constructor(period) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Stdev period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
    this.idx = 0;
    this.n = 0;
    this.value = NaN;
  }

  update(x) {
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
    for (let i = 0; i < this.period; i++) mean += this.window[i];
    mean /= this.period;
    let sq = 0;
    for (let i = 0; i < this.period; i++) {
      const d = this.window[i] - mean;
      sq += d * d;
    }
    this.value = Math.sqrt(sq / this.period);
    return this.value;
  }
}

// Running window sum.
export class SumState {
  constructor(period) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Sum period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
    this.idx = 0;
    this.n = 0;
    this.sum = 0;
    this.value = NaN;
  }

  update(x) {
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
    this.sum += v - this.window[this.idx];
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    this.value = this.sum;
    return this.value;
  }
}

// Linearly-weighted moving average: weights 1, 2, ..., N (heaviest on newest).
export class WmaState {
  constructor(period) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`WMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.window = new Float64Array(period);
    this.idx = 0;
    this.n = 0;
    this.denom = (period * (period + 1)) / 2;
    this.value = NaN;
  }

  update(x) {
    const v = Number.isFinite(x) ? x : 0;
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    if (this.n < this.period) this.n += 1;
    if (this.n < this.period) return NaN;
    // The window has period values starting from this.idx (oldest) wrapping around.
    let num = 0;
    let weight = 1;
    let cursor = this.idx; // oldest
    for (let i = 0; i < this.period; i++) {
      num += this.window[cursor] * weight;
      weight += 1;
      cursor = (cursor + 1) % this.period;
    }
    this.value = num / this.denom;
    return this.value;
  }
}

// Volume-weighted moving average over the last `period` bars.
export class VwmaState {
  constructor(period) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`VWMA period must be a positive integer (got ${period})`);
    }
    this.period = period;
    this.vals = new Float64Array(period);
    this.vols = new Float64Array(period);
    this.idx = 0;
    this.n = 0;
    this.numSum = 0;
    this.volSum = 0;
    this.value = NaN;
  }

  update(price, volume) {
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
    this.numSum += p * v - this.vals[this.idx] * this.vols[this.idx];
    this.volSum += v - this.vols[this.idx];
    this.vals[this.idx] = p;
    this.vols[this.idx] = v;
    this.idx = (this.idx + 1) % this.period;
    this.value = this.volSum === 0 ? NaN : this.numSum / this.volSum;
    return this.value;
  }
}

// "falling/rising over last N bars" — true iff src has been strictly monotonic
// in that direction over the last `len` samples (most-recent vs each preceding).
// Uses a small Float64Array history mirroring the call-site Series.
export class TrendState {
  constructor(period, mode /* 'falling' | 'rising' */) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Period must be a positive integer (got ${period})`);
    }
    if (mode !== 'falling' && mode !== 'rising') {
      throw new RangeError(`mode must be 'falling' or 'rising' (got ${mode})`);
    }
    this.period = period;
    this.mode = mode;
    this.window = new Float64Array(period + 1);
    this.idx = 0;
    this.n = 0;
  }

  update(x) {
    const v = Number.isFinite(x) ? x : NaN;
    this.window[this.idx] = v;
    this.idx = (this.idx + 1) % (this.period + 1);
    if (this.n <= this.period) this.n += 1;
    if (this.n <= this.period) return false;
    // Walk from oldest → newest and check monotonicity.
    let cursor = this.idx; // oldest (now points to slot just overwritten + 1)
    let prev = this.window[cursor];
    cursor = (cursor + 1) % (this.period + 1);
    for (let i = 0; i < this.period; i++) {
      const cur = this.window[cursor];
      if (this.mode === 'falling' && !(cur < prev)) return false;
      if (this.mode === 'rising' && !(cur > prev)) return false;
      prev = cur;
      cursor = (cursor + 1) % (this.period + 1);
    }
    return true;
  }
}

// Monotonic deque for O(1) amortized rolling max/min over the last `period` samples.
export class RollingExtreme {
  constructor(period, mode /* 'max' | 'min' */) {
    if (!Number.isInteger(period) || period <= 0) {
      throw new RangeError(`Period must be a positive integer (got ${period})`);
    }
    if (mode !== 'max' && mode !== 'min') {
      throw new RangeError(`mode must be 'max' or 'min' (got ${mode})`);
    }
    this.period = period;
    this.mode = mode;
    this.n = 0;
    // deque holds { idx, value }; front is the current extreme.
    this.deque = [];
  }

  update(x) {
    const idx = this.n;
    this.n += 1;
    if (!Number.isFinite(x)) return this.peek();
    // Drop expired front entries.
    while (this.deque.length && this.deque[0].idx <= idx - this.period) {
      this.deque.shift();
    }
    if (this.mode === 'max') {
      while (this.deque.length && this.deque[this.deque.length - 1].value <= x) {
        this.deque.pop();
      }
    } else {
      while (this.deque.length && this.deque[this.deque.length - 1].value >= x) {
        this.deque.pop();
      }
    }
    this.deque.push({ idx, value: x });
    if (idx < this.period - 1) return NaN;
    return this.deque[0].value;
  }

  peek() {
    if (this.n < this.period || this.deque.length === 0) return NaN;
    return this.deque[0].value;
  }
}
