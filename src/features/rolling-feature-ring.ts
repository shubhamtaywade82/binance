export class RollingFeatureRing {
  private readonly buf: Float64Array;
  private readonly capacity: number;
  private head = 0;
  private _size = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be positive');
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
  }

  push(value: number): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  get size(): number {
    return this._size;
  }

  mean(): number {
    if (this._size === 0) return 0;
    let sum = 0;
    const arr = this.buf;
    const start = this.startIndex();
    for (let i = 0; i < this._size; i++) {
      sum += arr[(start + i) % this.capacity];
    }
    return sum / this._size;
  }

  std(): number {
    if (this._size < 2) return 0;
    const m = this.mean();
    let sumSq = 0;
    const arr = this.buf;
    const start = this.startIndex();
    for (let i = 0; i < this._size; i++) {
      const d = arr[(start + i) % this.capacity] - m;
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / (this._size - 1));
  }

  min(): number {
    if (this._size === 0) return 0;
    let lo = Infinity;
    const arr = this.buf;
    const start = this.startIndex();
    for (let i = 0; i < this._size; i++) {
      const v = arr[(start + i) % this.capacity];
      if (v < lo) lo = v;
    }
    return lo;
  }

  max(): number {
    if (this._size === 0) return 0;
    let hi = -Infinity;
    const arr = this.buf;
    const start = this.startIndex();
    for (let i = 0; i < this._size; i++) {
      const v = arr[(start + i) % this.capacity];
      if (v > hi) hi = v;
    }
    return hi;
  }

  last(): number {
    if (this._size === 0) return 0;
    return this.buf[(this.head - 1 + this.capacity) % this.capacity];
  }

  toArray(): Float64Array {
    const out = new Float64Array(this._size);
    const start = this.startIndex();
    for (let i = 0; i < this._size; i++) {
      out[i] = this.buf[(start + i) % this.capacity];
    }
    return out;
  }

  private startIndex(): number {
    return this._size < this.capacity ? 0 : this.head;
  }
}
