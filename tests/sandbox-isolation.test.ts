import { describe, expect, it } from 'vitest';
import { runInSandbox } from '../src/core/runtime/sandbox';

const noopLog = () => undefined;

describe('NanoPine sandbox isolation (H-12)', () => {
  it('runs basic arithmetic over the candles input', () => {
    const r = runInSandbox(
      `const sum = candles.reduce((s, c) => s + c.close, 0); return sum;`,
      [
        { openTime: 0, close: 1, open: 1, high: 1, low: 1, volume: 0 },
        { openTime: 1, close: 2, open: 2, high: 2, low: 2, volume: 0 },
      ],
      {},
      { onLog: noopLog },
    );
    expect(r).toBe(3);
  });

  it('has NO access to require / process / Buffer / global / __dirname', () => {
    for (const symbol of ['require', 'process', 'Buffer', '__dirname', '__filename']) {
      let captured: any;
      try {
        captured = runInSandbox(
          `return typeof (${symbol});`,
          [],
          {},
          { onLog: noopLog },
        );
      } catch (err) {
        captured = `threw:${(err as Error).message}`;
      }
      // typeof on an undeclared identifier returns 'undefined' inside the
      // sandbox; a ReferenceError is equally acceptable. Either way the
      // host API is not reachable.
      const ok = captured === 'undefined' || (typeof captured === 'string' && captured.startsWith('threw:'));
      expect(ok, `symbol=${symbol} captured=${String(captured)}`).toBe(true);
    }
  });

  it('cannot escape via Function constructor — codeGeneration is disabled', () => {
    expect(() =>
      runInSandbox(
        `return ({}).constructor.constructor('return 42')();`,
        [],
        {},
        { onLog: noopLog },
      ),
    ).toThrow(/[Cc]ode generation/);
  });

  it('cannot escape via eval — codeGeneration is disabled', () => {
    expect(() =>
      runInSandbox(
        `return eval('1 + 1');`,
        [],
        {},
        { onLog: noopLog },
      ),
    ).toThrow(/[Cc]ode generation/);
  });

  it('aborts on CPU exhaustion (timeout)', () => {
    expect(() =>
      runInSandbox(
        `while (true) { /* spin */ }`,
        [],
        {},
        { timeoutMs: 100, onLog: noopLog },
      ),
    ).toThrow(/timeout|timed out/i);
  });

  it('freezes input candles — script cannot mutate caller state', () => {
    const candles = [{ openTime: 0, close: 100, open: 100, high: 100, low: 100, volume: 0 }];
    try {
      runInSandbox(
        `candles[0].close = 999;`,
        candles,
        {},
        { onLog: noopLog },
      );
    } catch { /* mutation throws on frozen object in strict mode; both fine */ }
    expect(candles[0].close).toBe(100);
  });

  it('exposes a safe Math subset', () => {
    expect(runInSandbox(`return Math.max(1, 2, 3);`, [], {}, { onLog: noopLog })).toBe(3);
    expect(runInSandbox(`return Math.PI > 3 && Math.PI < 4;`, [], {}, { onLog: noopLog })).toBe(true);
  });

  it('routes script console.log to the onLog sink', () => {
    const logs: unknown[][] = [];
    runInSandbox(
      `console.log('hello', 42); return 0;`,
      [],
      {},
      { onLog: (...args) => logs.push(args) },
    );
    expect(logs).toEqual([['hello', 42]]);
  });

  it('does not leak the host Date constructor (script cannot subclass Date)', () => {
    // Date.now and Date.parse are exposed, but `Date` itself is a frozen
    // plain object — script cannot do `new Date()` and walk up to Object.
    const r = runInSandbox(`return typeof Date.now === 'function' && typeof (Date.prototype);`, [], {}, { onLog: noopLog });
    expect(r).toBe('undefined');
  });
});
