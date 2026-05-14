export class NanoPineError extends Error {
  line?: number;
  col?: number;
  barIndex?: number;

  constructor(message: string, info?: Record<string, unknown>) {
    super(message);
    this.name = 'NanoPineError';
    if (info && typeof info === 'object') Object.assign(this, info);
  }
}

export class LexError extends NanoPineError {
  constructor(message: string, info?: Record<string, unknown>) {
    super(message, info);
    this.name = 'LexError';
  }
}

export class ParseError extends NanoPineError {
  constructor(message: string, info?: Record<string, unknown>) {
    super(message, info);
    this.name = 'ParseError';
  }
}

export class ValidationError extends NanoPineError {
  constructor(message: string, info?: Record<string, unknown>) {
    super(message, info);
    this.name = 'ValidationError';
  }
}

export class RuntimeError extends NanoPineError {
  constructor(message: string, info?: Record<string, unknown>) {
    super(message, info);
    this.name = 'RuntimeError';
  }
}

export class QuotaError extends NanoPineError {
  constructor(message: string, info?: Record<string, unknown>) {
    super(message, info);
    this.name = 'QuotaError';
  }
}
