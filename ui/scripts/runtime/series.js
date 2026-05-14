// Float64Array ring buffer with newest-first lookback semantics.
// `get(0)` returns the most recently pushed value; `get(k)` returns k bars ago.
// Once filled to capacity, older values are overwritten — `get(barsAgo)` past the
// available window returns NaN (matches Pine `na`).

export const DEFAULT_SERIES_CAPACITY = 5000;

export class Series {
  constructor(capacity = DEFAULT_SERIES_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`Series capacity must be a positive integer (got ${capacity})`);
    }
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
    this.head = -1; // index in buf of the newest value
    this.filled = 0; // count of valid samples, capped at capacity
  }

  push(value) {
    this.head = (this.head + 1) % this.capacity;
    this.buf[this.head] = Number.isFinite(value) ? value : NaN;
    if (this.filled < this.capacity) this.filled += 1;
  }

  get(barsAgo = 0) {
    if (!Number.isFinite(barsAgo) || barsAgo < 0) return NaN;
    const k = barsAgo | 0;
    if (k >= this.filled) return NaN;
    const idx = (this.head - k + this.capacity) % this.capacity;
    return this.buf[idx];
  }

  length() {
    return this.filled;
  }
}
