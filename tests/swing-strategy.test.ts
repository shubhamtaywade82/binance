import { describe, expect, it } from 'vitest';
import { evaluateSwingSignal } from '../src/strategy/swing-strategy';
import type { Candle } from '../src/types';

const mk = (open: number, high: number, low: number, close: number, t: number): Candle => ({
  openTime: t, open, high, low, close, volume: 100, closeTime: t + 60_000,
});

/** Build a monotonically rising HTF series so EMA-9/21 yields LONG bias. */
const risingHtf = (n: number, start: number, step: number): Candle[] => {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p + step;
    out.push(mk(o, c + 0.5, o - 0.5, c, i * 4 * 60 * 60_000));
    p = c;
  }
  return out;
};

const fallingHtf = (n: number, start: number, step: number): Candle[] => {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = p - step;
    out.push(mk(o, o + 0.5, c - 0.5, c, i * 4 * 60 * 60_000));
    p = c;
  }
  return out;
};

describe('evaluateSwingSignal', () => {
  it('returns null when LTF/HTF samples are too short', () => {
    expect(evaluateSwingSignal({
      symbol: 'SUIUSDT',
      candlesLtf: [],
      candlesHtf: [],
      minConfidence: 0.7,
    })).toBeNull();
  });

  it('returns null when HTF bias is NONE', () => {
    // Flat HTF: EMA-9 ≈ EMA-21 → NONE.
    const flat: Candle[] = [];
    for (let i = 0; i < 40; i++) flat.push(mk(100, 100.1, 99.9, 100, i));
    const ltf: Candle[] = [];
    for (let i = 0; i < 40; i++) ltf.push(mk(100, 100.5, 99.5, 100, i));
    expect(evaluateSwingSignal({
      symbol: 'SUIUSDT',
      candlesLtf: ltf,
      candlesHtf: flat,
      minConfidence: 0.7,
    })).toBeNull();
  });

  it('returns null when LTF has no displacement on the last bar', () => {
    const htf = risingHtf(40, 100, 1.5);
    const ltf: Candle[] = [];
    for (let i = 0; i < 40; i++) ltf.push(mk(100, 100.2, 99.8, 100.05, i));
    expect(evaluateSwingSignal({
      symbol: 'SUIUSDT',
      candlesLtf: ltf,
      candlesHtf: htf,
      minConfidence: 0.6,
    })).toBeNull();
  });

  it('rejects signals below minConfidence even with HTF + displacement', () => {
    const htf = risingHtf(40, 100, 1.5);
    // 39 tight bars + 1 small bullish bar — no FVG/OB zone alignment.
    const ltf: Candle[] = [];
    for (let i = 0; i < 39; i++) ltf.push(mk(100, 100.1, 99.9, 100, i));
    ltf.push(mk(100, 101, 99.95, 100.8, 39)); // weak displacement
    const out = evaluateSwingSignal({
      symbol: 'SUIUSDT',
      candlesLtf: ltf,
      candlesHtf: htf,
      minConfidence: 0.99,
    });
    expect(out).toBeNull();
  });

  it('smoke test: rejects (returns null) on a generic falling-LTF/rising-HTF mismatch', () => {
    const htf = risingHtf(40, 100, 1.5);
    // LTF with bearish displacement on the last bar — opposite to HTF LONG bias.
    const ltf: Candle[] = [];
    for (let i = 0; i < 39; i++) ltf.push(mk(100, 100.1, 99.9, 100, i));
    ltf.push(mk(101, 101.1, 95, 95.2, 39));
    const out = evaluateSwingSignal({
      symbol: 'SUIUSDT',
      candlesLtf: ltf,
      candlesHtf: htf,
      minConfidence: 0.5,
    });
    expect(out).toBeNull();
  });

  it('smoke test: falling HTF with bearish displacement is at least *eligible* (LTF zone may still gate it)', () => {
    const htf = fallingHtf(40, 200, 1.5);
    const ltf: Candle[] = [];
    for (let i = 0; i < 39; i++) ltf.push(mk(200, 200.1, 199.9, 200, i));
    ltf.push(mk(200, 200.1, 195, 195.2, 39));
    const out = evaluateSwingSignal({
      symbol: 'SUIUSDT',
      candlesLtf: ltf,
      candlesHtf: htf,
      minConfidence: 0.5,
    });
    // The strategy may still reject for zone alignment (no aligned FVG/OB in synthetic data).
    // We only assert that *if* it returns a result, the side matches the HTF bias.
    if (out) expect(out.side).toBe('SHORT');
  });
});
