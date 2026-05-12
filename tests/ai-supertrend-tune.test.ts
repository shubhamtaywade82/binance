import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candle } from '../src/types';

const { mockChat, MockOllama } = vi.hoisted(() => {
  const mockChat = vi.fn();
  const MockOllama = vi.fn().mockImplementation(() => ({ chat: mockChat }));
  return { mockChat, MockOllama };
});

vi.mock('ollama', () => ({
  Ollama: MockOllama,
}));

import {
  buildSupertrendTuneSnapshot,
  parseSupertrendTuneResponse,
  requestSupertrendTune,
} from '../src/ai/supertrend-tune';

function synthCandles(n: number, startPrice = 100): Candle[] {
  const out: Candle[] = [];
  let p = startPrice;
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    const wiggle = Math.sin(i * 0.2) * 0.8 + (i % 7) * 0.05;
    const o = p;
    p = o + wiggle;
    const h = Math.max(o, p) + 0.3;
    const l = Math.min(o, p) - 0.3;
    const openTime = t0 + i * 60_000;
    out.push({
      openTime,
      open: o,
      high: h,
      low: l,
      close: p,
      volume: 10,
      closeTime: openTime + 59_999,
    });
  }
  return out;
}

describe('parseSupertrendTuneResponse', () => {
  it('parses plain JSON with atrPeriod and multiplier', () => {
    const r = parseSupertrendTuneResponse('{"atrPeriod":14,"multiplier":2.5}');
    expect(r).toEqual({ atrPeriod: 14, multiplier: 2.5 });
  });

  it('accepts period and mult aliases', () => {
    const r = parseSupertrendTuneResponse('{"period": 9, "mult": 3.25}');
    expect(r).toEqual({ atrPeriod: 9, multiplier: 3.25 });
  });

  it('extracts JSON from a markdown fence', () => {
    const r = parseSupertrendTuneResponse('Here\n```json\n{"atrPeriod":11,"multiplier":2}\n```\n');
    expect(r).toEqual({ atrPeriod: 11, multiplier: 2 });
  });

  it('clamps atrPeriod and multiplier into allowed ranges', () => {
    expect(parseSupertrendTuneResponse('{"atrPeriod":2,"multiplier":9}')).toEqual({
      atrPeriod: 5,
      multiplier: 5,
    });
    expect(parseSupertrendTuneResponse('{"atrPeriod":99,"multiplier":0.1}')).toEqual({
      atrPeriod: 30,
      multiplier: 1.5,
    });
  });

  it('returns null for invalid JSON', () => {
    expect(parseSupertrendTuneResponse('not json')).toBeNull();
    expect(parseSupertrendTuneResponse('{"atrPeriod":"x"}')).toBeNull();
  });
});

describe('buildSupertrendTuneSnapshot', () => {
  it('returns null when fewer than 60 bars', () => {
    const candles = synthCandles(40);
    expect(buildSupertrendTuneSnapshot('X', '5m', candles, 10, 3)).toBeNull();
  });

  it('returns a snapshot for sufficient bars', () => {
    const candles = synthCandles(80);
    const s = buildSupertrendTuneSnapshot('SOLUSDT', '5m', candles, 10, 3);
    expect(s).not.toBeNull();
    expect(s?.symbol).toBe('SOLUSDT');
    expect(s?.timeframe).toBe('5m');
    expect(s?.barCount).toBeGreaterThanOrEqual(60);
    expect(s?.currentAtrPeriod).toBe(10);
    expect(s?.currentMultiplier).toBe(3);
    expect(typeof s?.baselineFlips50).toBe('number');
  });
});

describe('requestSupertrendTune', () => {
  const baseCfg = {
    host: 'http://127.0.0.1:11434',
    model: 'llama3.2',
    timeoutMs: 5000,
  } as const;

  const snapshot = {
    symbol: 'SOLUSDT',
    timeframe: '5m',
    barCount: 80,
    lastClose: 100,
    rangeCompression50: 0.05,
    returnVolatility50: 0.12,
    baselineFlips50: 4,
    currentAtrPeriod: 10,
    currentMultiplier: 3,
  };

  beforeEach(() => {
    mockChat.mockResolvedValue({
      message: { content: '{"atrPeriod":12,"multiplier":2.75}' },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed params from Ollama chat', async () => {
    const r = await requestSupertrendTune({ ...baseCfg }, snapshot);
    expect(r.error).toBeNull();
    expect(r.params).toEqual({ atrPeriod: 12, multiplier: 2.75 });
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'llama3.2',
        stream: false,
        messages: expect.arrayContaining([
          { role: 'system', content: expect.stringContaining('SuperTrend') },
          { role: 'user', content: expect.stringContaining('SOLUSDT') },
        ]),
      }),
    );
  });

  it('returns error when model is blank', async () => {
    const r = await requestSupertrendTune({ ...baseCfg, model: '   ' }, snapshot);
    expect(r.params).toBeNull();
    expect(r.error).toBe('missing_ollama_model');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('maps invalid JSON completion to invalid_tune_json', async () => {
    mockChat.mockResolvedValueOnce({ message: { content: 'cannot comply' } });
    const r = await requestSupertrendTune({ ...baseCfg }, snapshot);
    expect(r.params).toBeNull();
    expect(r.error).toBe('invalid_tune_json');
  });
});
