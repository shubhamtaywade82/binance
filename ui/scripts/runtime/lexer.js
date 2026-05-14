// NanoPine tokenizer.
//
// Token shape: { type, value?, line, col }
// Punctuation tokens use type === value (e.g. '(', ')', '[', ']', ',', '?', ':', '.', '=').
// Operators use their literal text ('+', '-', '*', '/', '%', '==', '!=', '<', '<=', '>', '>=').
// Keywords are emitted as themselves ('indicator', 'input', 'true', 'false', 'na', 'and', 'or', 'not').
// Identifiers: { type: 'ident', value }. Numbers: { type: 'number', value }.
// Strings: { type: 'string', value }. Newlines are significant — emitted as { type: 'newline' }
// so the parser can use them as statement terminators.

import { LexError } from './errors.js';

const KEYWORDS = new Set([
  'indicator',
  'strategy',
  'input',
  'true',
  'false',
  'na',
  'and',
  'or',
  'not',
]);

const SINGLE_PUNCT = new Set(['(', ')', '[', ']', ',', '?', ':', '.', '+', '-', '*', '/', '%']);

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  const peek = (k = 0) => (i + k < n ? source[i + k] : '');
  const advance = () => {
    const ch = source[i++];
    if (ch === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    return ch;
  };

  while (i < n) {
    const ch = peek();

    // Newline (significant).
    if (ch === '\n') {
      tokens.push({ type: 'newline', line, col });
      advance();
      continue;
    }

    // Whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      advance();
      continue;
    }

    // Line comment: // until end of line.
    if (ch === '/' && peek(1) === '/') {
      while (i < n && peek() !== '\n') advance();
      continue;
    }

    // String literal — double-quoted only, no escapes except \" and \\.
    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      advance(); // opening quote
      let s = '';
      while (i < n && peek() !== '"') {
        if (peek() === '\\') {
          advance();
          const esc = peek();
          if (esc === '"' || esc === '\\') {
            s += esc;
            advance();
          } else if (esc === 'n') {
            s += '\n';
            advance();
          } else if (esc === 't') {
            s += '\t';
            advance();
          } else {
            throw new LexError(`Invalid string escape \\${esc}`, { line, col });
          }
          continue;
        }
        if (peek() === '\n') {
          throw new LexError('Unterminated string literal', { line: startLine, col: startCol });
        }
        s += advance();
      }
      if (i >= n) {
        throw new LexError('Unterminated string literal', { line: startLine, col: startCol });
      }
      advance(); // closing quote
      tokens.push({ type: 'string', value: s, line: startLine, col: startCol });
      continue;
    }

    // Number literal — integer or decimal. No exponent in MVP.
    if (isDigit(ch) || (ch === '.' && isDigit(peek(1)))) {
      const startLine = line;
      const startCol = col;
      let s = '';
      let seenDot = false;
      while (i < n) {
        const c = peek();
        if (isDigit(c)) {
          s += c;
          advance();
        } else if (c === '.' && !seenDot && isDigit(peek(1))) {
          seenDot = true;
          s += c;
          advance();
        } else {
          break;
        }
      }
      const value = Number(s);
      if (!Number.isFinite(value)) {
        throw new LexError(`Invalid number literal '${s}'`, { line: startLine, col: startCol });
      }
      tokens.push({ type: 'number', value, line: startLine, col: startCol });
      continue;
    }

    // Identifier / keyword.
    if (isIdentStart(ch)) {
      const startLine = line;
      const startCol = col;
      let s = '';
      while (i < n && isIdentPart(peek())) {
        s += advance();
      }
      if (KEYWORDS.has(s)) {
        tokens.push({ type: s, line: startLine, col: startCol });
      } else {
        tokens.push({ type: 'ident', value: s, line: startLine, col: startCol });
      }
      continue;
    }

    // Two-character operators.
    if (ch === '=' && peek(1) === '=') {
      tokens.push({ type: '==', line, col });
      advance();
      advance();
      continue;
    }
    if (ch === '!' && peek(1) === '=') {
      tokens.push({ type: '!=', line, col });
      advance();
      advance();
      continue;
    }
    if (ch === '<' && peek(1) === '=') {
      tokens.push({ type: '<=', line, col });
      advance();
      advance();
      continue;
    }
    if (ch === '>' && peek(1) === '=') {
      tokens.push({ type: '>=', line, col });
      advance();
      advance();
      continue;
    }

    // Single-char operators / punctuation / comparators.
    if (ch === '<' || ch === '>' || ch === '=') {
      tokens.push({ type: ch, line, col });
      advance();
      continue;
    }
    if (SINGLE_PUNCT.has(ch)) {
      tokens.push({ type: ch, line, col });
      advance();
      continue;
    }

    throw new LexError(`Unexpected character '${ch}'`, { line, col });
  }

  tokens.push({ type: 'eof', line, col });
  return tokens;
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch);
}
