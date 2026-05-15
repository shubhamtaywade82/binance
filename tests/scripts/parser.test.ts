import { describe, expect, it } from 'vitest';
import { ParseError, parse, tokenize } from '@coindcx/indicator-runtime';

const ast = (src: string) => parse(tokenize(src));

describe('parser', () => {
  it('parses indicator() with kwargs', () => {
    const p: any = ast('indicator("X", overlay=true)');
    expect(p.body).toHaveLength(1);
    expect(p.body[0].type).toBe('IndicatorDecl');
    expect(p.body[0].name).toBe('X');
    expect(p.body[0].opts[0].name).toBe('overlay');
    expect(p.body[0].opts[0].value.type).toBe('Bool');
    expect(p.body[0].opts[0].value.value).toBe(true);
  });

  it('parses input.int(...) declarations', () => {
    const p: any = ast('len = input.int(9, title="Length")');
    expect(p.body[0].type).toBe('InputDecl');
    expect(p.body[0].kind).toBe('int');
    expect(p.body[0].name).toBe('len');
    expect(p.body[0].args).toHaveLength(1);
    expect(p.body[0].args[0].value).toBe(9);
    expect(p.body[0].kwargs[0].name).toBe('title');
  });

  it('parses assignments and call statements', () => {
    const p: any = ast('e9 = ema(close, 9)\nplot(e9)');
    expect(p.body[0].type).toBe('Assign');
    expect(p.body[0].name).toBe('e9');
    expect(p.body[0].value.type).toBe('Call');
    expect(p.body[0].value.callee).toBe('ema');
    expect(p.body[1].type).toBe('ExprStmt');
    expect(p.body[1].expr.type).toBe('Call');
    expect(p.body[1].expr.callee).toBe('plot');
  });

  it('parses indexing close[1]', () => {
    const p: any = ast('x = close[1]');
    expect(p.body[0].value.type).toBe('Index');
    expect(p.body[0].value.target.type).toBe('Ident');
    expect(p.body[0].value.target.name).toBe('close');
    expect(p.body[0].value.index.value).toBe(1);
  });

  it('honours operator precedence', () => {
    // a + b * c → Binary(+, a, Binary(*, b, c))
    const p: any = ast('x = a + b * c');
    const expr = p.body[0].value;
    expect(expr.type).toBe('Binary');
    expect(expr.op).toBe('+');
    expect(expr.right.type).toBe('Binary');
    expect(expr.right.op).toBe('*');
  });

  it('rejects positional args after kwargs', () => {
    expect(() => ast('plot(title="x", 1)')).toThrow(ParseError);
  });

  it('rejects unknown input kinds', () => {
    expect(() => ast('x = input.unknown(1)')).toThrow(ParseError);
  });
});
