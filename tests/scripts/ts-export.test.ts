import { describe, expect, it } from 'vitest';
import { tokenize, parse } from '@coindcx/indicator-runtime';
// @ts-expect-error — JS module
import { generateStrategyTs } from '../../ui/scripts/ui/ts-export.js';

const sc = (name: string, source: string) => ({
  id: 's1',
  name,
  source,
  inputs: {},
  enabled: false,
  createdAt: 1,
  updatedAt: 1,
});

describe('generateStrategyTs', () => {
  it('refuses to export an indicator (non-strategy) script', () => {
    const program = parse(tokenize('indicator("X")\nplot(close)'));
    expect(() => generateStrategyTs(sc('X', 'indicator("X")\nplot(close)'), program)).toThrow(
      /strategy/i,
    );
  });

  it('emits a TS file with sane structure for an EMA-cross strategy', () => {
    const source = [
      'strategy("EMA Cross", initial_capital=10000)',
      'fastLen = input.int(9, title="Fast")',
      'slowLen = input.int(21, title="Slow")',
      'fast = ema(close, fastLen)',
      'slow = ema(close, slowLen)',
      'entry(crossover(fast, slow), "long")',
      'entry(crossunder(fast, slow), "short")',
    ].join('\n');
    const program = parse(tokenize(source));
    const out = generateStrategyTs(sc('EMA Cross', source), program);
    expect(out.filename.endsWith('.ts')).toBe(true);
    // Identifier built from name.
    expect(out.source).toMatch(/EMACross/);
    // Input typings + defaults.
    expect(out.source).toMatch(/fastLen: number;/);
    expect(out.source).toMatch(/fastLen: 9,/);
    // Imports the existing strategy primitives.
    expect(out.source).toMatch(/from '\.\/indicators'/);
    // Translates entry calls into signal branches.
    expect(out.source).toMatch(/action: 'open', side: 'LONG'/);
    expect(out.source).toMatch(/action: 'open', side: 'SHORT'/);
    expect(out.source).toMatch(/return \{ action: 'hold' \};/);
    // Translates expressions and crosses.
    expect(out.source).toMatch(/_crossover\(/);
    expect(out.source).toMatch(/_ema\(closes, fastLen\)/);
  });

  it('falls back to a TODO for unsupported builtins', () => {
    const source = [
      'strategy("WithSec")',
      'h = security("1h", "close")',
      'entry(h > close, "long")',
    ].join('\n');
    const program = parse(tokenize(source));
    const out = generateStrategyTs(sc('WithSec', source), program);
    expect(out.source).toMatch(/TODO: security/);
  });
});
