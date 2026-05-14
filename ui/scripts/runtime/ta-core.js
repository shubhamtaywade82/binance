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
