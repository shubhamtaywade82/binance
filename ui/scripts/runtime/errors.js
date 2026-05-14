// NanoPine runtime error classes. Kept as small ESM JS so the worker bundle stays minimal
// and the same module can be imported by both the worker and unit tests under Node.

export class NanoPineError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'NanoPineError';
    if (info && typeof info === 'object') Object.assign(this, info);
  }
}

export class LexError extends NanoPineError {
  constructor(message, info) {
    super(message, info);
    this.name = 'LexError';
  }
}

export class ParseError extends NanoPineError {
  constructor(message, info) {
    super(message, info);
    this.name = 'ParseError';
  }
}

export class ValidationError extends NanoPineError {
  constructor(message, info) {
    super(message, info);
    this.name = 'ValidationError';
  }
}

export class RuntimeError extends NanoPineError {
  constructor(message, info) {
    super(message, info);
    this.name = 'RuntimeError';
  }
}

export class QuotaError extends NanoPineError {
  constructor(message, info) {
    super(message, info);
    this.name = 'QuotaError';
  }
}
