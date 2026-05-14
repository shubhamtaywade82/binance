import { describe, expect, it } from 'vitest';
// @ts-expect-error — JS module, vitest will transpile via esbuild
import { tokenize } from '../../ui/scripts/runtime/lexer.js';
// @ts-expect-error — JS module
import { LexError } from '../../ui/scripts/runtime/errors.js';

describe('lexer', () => {
  it('tokenises an EMA assignment', () => {
    const toks = tokenize('e9 = ema(close, 9)').map((t: any) => t.type);
    expect(toks).toEqual(['ident', '=', 'ident', '(', 'ident', ',', 'number', ')', 'eof']);
  });

  it('emits newline tokens between statements', () => {
    const toks = tokenize('a = 1\nb = 2').map((t: any) => t.type);
    expect(toks).toEqual(['ident', '=', 'number', 'newline', 'ident', '=', 'number', 'eof']);
  });

  it('handles ternary, strings, na, and comparators', () => {
    const src = 'x = close > open ? "up" : na';
    const toks = tokenize(src);
    const types = toks.map((t: any) => t.type);
    expect(types).toEqual([
      'ident',
      '=',
      'ident',
      '>',
      'ident',
      '?',
      'string',
      ':',
      'na',
      'eof',
    ]);
    const str = toks.find((t: any) => t.type === 'string')!;
    expect((str as any).value).toBe('up');
  });

  it('parses decimal numbers including leading-dot form', () => {
    const toks = tokenize('a = 1.5\nb = .25');
    const nums = toks.filter((t: any) => t.type === 'number').map((t: any) => t.value);
    expect(nums).toEqual([1.5, 0.25]);
  });

  it('rejects unterminated strings', () => {
    expect(() => tokenize('a = "oops')).toThrow(LexError);
  });

  it('treats // as a line comment', () => {
    const toks = tokenize('a = 1 // comment goes here\nb = 2').map((t: any) => t.type);
    expect(toks).toEqual(['ident', '=', 'number', 'newline', 'ident', '=', 'number', 'eof']);
  });

  it('emits keywords as their own token type', () => {
    const toks = tokenize('not true and false or na').map((t: any) => t.type);
    expect(toks).toEqual(['not', 'true', 'and', 'false', 'or', 'na', 'eof']);
  });
});
