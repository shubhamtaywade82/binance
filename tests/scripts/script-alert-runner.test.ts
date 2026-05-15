import { describe, expect, it } from 'vitest';
import { createScriptAlertRunner } from '../../src/dashboard/script-alert-runner';
import type { Candle } from '../../src/types';

// Inject runtime modules directly — vitest's vm context doesn't have a dynamic
// import callback, so the production loader (via `new Function('return import(s)')`)
// fails in tests.
import {
  tokenize,
  parse,
  prepare,
  runBar,
  createContext,
} from '@coindcx/indicator-runtime';

const loadRuntimeModules = async () => ({
  tokenize,
  parse,
  prepare,
  runBar,
  createContext,
});

const mkCandle = (openTime: number, close: number): Candle => ({
  openTime,
  open: close,
  high: close + 0.5,
  low: close - 0.5,
  close,
  volume: 1,
});

const sc = (id: string, source: string, runServerSide = true) => ({
  id,
  name: id,
  source,
  inputs: {},
  enabled: true,
  runServerSide,
  createdAt: 1,
  updatedAt: 1,
});

describe('ScriptAlertRunner', () => {
  it('emits alerts only for server-side scripts on the configured TF', async () => {
    const events: any[] = [];
    const runner = createScriptAlertRunner({
      evaluationTf: '5m',
      onAlert: (ev) => events.push(ev),
      loadRuntimeModules,
    });
    await runner.setScripts([
      sc(
        'server',
        ['indicator("S")', 'up = close > close[1]', 'alert(up, "Server bar up")'].join('\n'),
      ),
      sc(
        'client_only',
        ['indicator("C")', 'alert(true, "Should not fire")'].join('\n'),
        false,
      ),
    ]);

    const t0 = Date.UTC(2025, 0, 1, 9, 0, 0);
    // First bar — close[1] is NaN, alert won't fire.
    await runner.onClosedBar('BTCUSDT', '5m', mkCandle(t0, 100));
    // Second bar — close 101 > 100 → alert fires.
    await runner.onClosedBar('BTCUSDT', '5m', mkCandle(t0 + 300_000, 101));
    // Third bar — close 100 < 101 → alert does not fire.
    await runner.onClosedBar('BTCUSDT', '5m', mkCandle(t0 + 600_000, 100));
    // Fourth bar on a different TF — runner ignores it.
    await runner.onClosedBar('BTCUSDT', '1h', mkCandle(t0 + 3_600_000, 200));

    expect(events.length).toBe(1);
    expect(events[0].scriptId).toBe('server');
    expect(events[0].message).toBe('Server bar up');
    expect(events[0].bar).toBe(1);
  });

  it('survives a script with a runtime error and keeps evaluating the others', async () => {
    const events: any[] = [];
    const warnings: any[] = [];
    const runner = createScriptAlertRunner({
      evaluationTf: '5m',
      onAlert: (ev) => events.push(ev),
      log: { warn: (m, ctx) => warnings.push({ m, ctx }) },
      loadRuntimeModules,
    });
    await runner.setScripts([
      sc(
        'broken',
        ['indicator("B")', 'plot(highest(close, 999999))'].join('\n'),
      ),
      sc(
        'ok',
        ['indicator("O")', 'alert(true, "every bar")'].join('\n'),
      ),
    ]);

    const t0 = Date.UTC(2025, 0, 2);
    await runner.onClosedBar('SOLUSDT', '5m', mkCandle(t0, 50));
    expect(events.find((e) => e.scriptId === 'ok')).toBeTruthy();
    expect(warnings.find((w) => w.m === 'script_alert_runtime_error')).toBeTruthy();
  });

  it('replaces previous scripts on setScripts and drops removed ones', async () => {
    const events: any[] = [];
    const runner = createScriptAlertRunner({
      evaluationTf: '5m',
      onAlert: (ev) => events.push(ev),
      loadRuntimeModules,
    });
    await runner.setScripts([sc('a', 'indicator("A")\nalert(true, "A bar")')]);
    const t0 = Date.UTC(2025, 0, 3);
    await runner.onClosedBar('BTCUSDT', '5m', mkCandle(t0, 1));
    expect(events.find((e) => e.scriptId === 'a')).toBeTruthy();
    events.length = 0;
    // Replace with a single fresh script — old "a" is gone.
    await runner.setScripts([sc('b', 'indicator("B")\nalert(true, "B bar")')]);
    await runner.onClosedBar('BTCUSDT', '5m', mkCandle(t0 + 300_000, 2));
    expect(events.find((e) => e.scriptId === 'a')).toBeFalsy();
    expect(events.find((e) => e.scriptId === 'b')).toBeTruthy();
  });
});
