import { describe, it, expect } from 'vitest';
import { adx } from '../src/strategy/indicators';
import { SeykotaTrendModule, DEFAULT_SEYKOTA } from '../src/strategy/seykota-module';
import type { StrategyContext } from '../src/core/strategy/strategy-module';
import type { Candle } from '../src/types';
import { EventBus } from '../src/core/events/event-bus';

function makeCandles(n: number, gen: (i: number) => Partial<Candle> & { close: number }): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const g = gen(i);
    const close = g.close;
    return {
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000 - 1,
      open: g.open ?? close,
      high: g.high ?? close + 1,
      low: g.low ?? close - 1,
      close,
      volume: g.volume ?? 100,
    };
  });
}

function ctx(symbol: string, ltf: Candle[], htf: Candle[], bus = new EventBus()): StrategyContext {
  return {
    symbol,
    timeframe: '15m',
    getHistory: (tf?: string) => (tf && tf !== '15m' ? htf : ltf),
    eventBus: bus,
  };
}

describe('ADX', () => {
  it('produces NaN until 2×period bars and ~0 on flat price', () => {
    const flat = makeCandles(60, () => ({ close: 100, high: 100.1, low: 99.9 }));
    const r = adx(flat, 14);
    expect(r.adx.slice(0, 27).every((v) => Number.isNaN(v))).toBe(true);
    const last = r.adx[r.adx.length - 1];
    expect(last).toBeLessThan(20);
  });

  it('rises with a strong uptrend (+DI > -DI)', () => {
    const up = makeCandles(80, (i) => ({ close: 100 + i, high: 100 + i + 0.5, low: 100 + i - 0.3 }));
    const r = adx(up, 14);
    const last = r.adx[r.adx.length - 1];
    expect(last).toBeGreaterThan(40);
    expect(r.plusDi[r.plusDi.length - 1]).toBeGreaterThan(r.minusDi[r.minusDi.length - 1]);
  });
});

describe('SeykotaTrendModule', () => {
  const cfg = { ...DEFAULT_SEYKOTA, equityUsdt: 10_000, riskPct: 0.005, atrMult: 3, minBars: 60 };

  it('returns null in chop (flat market)', () => {
    const flat = makeCandles(120, () => ({ close: 100, high: 100.05, low: 99.95 }));
    const s = new SeykotaTrendModule(ctx('BTCUSDT', flat, flat), cfg);
    const out = s.onKline(flat[flat.length - 1]);
    expect(out).toBeNull();
  });

  it('emits LONG OrderRequested in strong uptrend with HTF + LTF aligned', () => {
    // both LTF + HTF rising steadily — easy regime
    const up = makeCandles(160, (i) => ({
      close: 100 + i * 0.6,
      high: 100 + i * 0.6 + 0.4,
      low: 100 + i * 0.6 - 0.2,
    }));
    const s = new SeykotaTrendModule(ctx('BTCUSDT', up, up), cfg);
    const out = s.onKline(up[up.length - 1]);
    expect(out).not.toBeNull();
    expect(out!.side).toBe('LONG');
    expect(out!.symbol).toBe('BTCUSDT');
    expect(out!.stopLoss).toBeDefined();
    expect(out!.stopLoss!).toBeLessThan(out!.price!);
    expect(out!.quantity).toBeGreaterThan(0);
    // risk math: qty * stopDistance ≈ equity * riskPct
    const risk = out!.quantity * (out!.price! - out!.stopLoss!);
    expect(risk).toBeCloseTo(cfg.equityUsdt * cfg.riskPct, 5);
  });

  it('emits SHORT in strong downtrend', () => {
    const down = makeCandles(160, (i) => ({
      close: 200 - i * 0.6,
      high: 200 - i * 0.6 + 0.2,
      low: 200 - i * 0.6 - 0.4,
    }));
    const s = new SeykotaTrendModule(ctx('ETHUSDT', down, down), cfg);
    const out = s.onKline(down[down.length - 1]);
    expect(out).not.toBeNull();
    expect(out!.side).toBe('SHORT');
    expect(out!.stopLoss!).toBeGreaterThan(out!.price!);
  });

  it('rejects when HTF and LTF disagree', () => {
    const upLtf = makeCandles(160, (i) => ({ close: 100 + i * 0.6 }));
    const downHtf = makeCandles(160, (i) => ({ close: 200 - i * 0.6 }));
    const s = new SeykotaTrendModule(ctx('BTCUSDT', upLtf, downHtf), cfg);
    expect(s.onKline(upLtf[upLtf.length - 1])).toBeNull();
  });

  it('emits PYRAMID signal when price moves in favor after first fill', () => {
    const bus = new EventBus();
    const up = makeCandles(160, (i) => ({
      close: 100 + i * 0.6,
      high: 100 + i * 0.6 + 0.4,
      low: 100 + i * 0.6 - 0.2,
    }));
    const s = new SeykotaTrendModule(ctx('SOLUSDT', up, up, bus), { ...cfg, pyramidMaxAdds: 2 });

    // 1. Initial entry
    const out1 = s.onKline(up[up.length - 2]);
    expect(out1?.reason).toBe('ENTRY');

    // 2. Simulate FILL
    bus.publish({
      type: 'execution.order.filled',
      symbol: 'SOLUSDT',
      payload: { symbol: 'SOLUSDT', side: 'LONG', price: 190, quantity: 10 }
    });

    // 3. Next kline is further in favor → PYRAMID
    const out2 = s.onKline(up[up.length - 1]);
    expect(out2?.reason).toBe('PYRAMID');
  });
});
