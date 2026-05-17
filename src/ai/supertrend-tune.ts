/**
 * Periodic Ollama suggestion for SuperTrend ATR period and multiplier only.
 * Chart math stays deterministic via {@link supertrend} in `src/strategy/indicators.ts`.
 */

import { Ollama } from 'ollama';
import { formatOllamaRequestError } from './ollama-request-error';
import { supertrend } from '../strategy/indicators';
import type { Candle } from '../types';

export interface SupertrendTuneSnapshot {
  symbol: string;
  timeframe: string;
  barCount: number;
  lastClose: number;
  /** (max high − min low) / lastClose over the last 50 closed bars in the sample. */
  rangeCompression50: number;
  /** Sample stdev of simple period-over-period returns (last 50 deltas). */
  returnVolatility50: number;
  /** Direction flips in the last 50 bars using baseline SuperTrend(10, 3). */
  baselineFlips50: number;
  currentAtrPeriod: number;
  currentMultiplier: number;
}

export interface OllamaSupertrendTuneConfig {
  host: string;
  model: string;
  timeoutMs: number;
  /** The total context window (input + output) requested in tokens. */
  contextSize: number;
  apiKey?: string;
}

const DEFAULT_PERIOD = 10;
const DEFAULT_MULT = 3;
const MIN_PERIOD = 5;
const MAX_PERIOD = 30;
const MIN_MULT = 1.5;
const MAX_MULT = 5;

const SYSTEM_PROMPT = `You tune SuperTrend indicator parameters for a crypto charting dashboard.
You receive compact numeric context only (no raw OHLCV arrays).

Reply with a single JSON object and nothing else — no markdown, no code fences, no commentary.
Schema:
{"atrPeriod": <integer>, "multiplier": <number>}

Rules:
- atrPeriod: integer from 5 to 30 (ATR length inside SuperTrend).
- multiplier: number from 1.5 to 5 (ATR multiple for bands).
- Prefer wider bands (higher multiplier and/or period) when returnVolatility50 or rangeCompression50 is high (choppy / wide-range).
- Prefer slightly tighter parameters when baselineFlips50 is very high (noisy flips) unless volatility is extreme.
- currentAtrPeriod and currentMultiplier are the active values; you may keep them if they still fit the context.`;

const createTimeoutFetch = (timeoutMs: number): typeof fetch => {
  const ms = Math.max(1000, timeoutMs);
  return (input, init) => {
    const t = AbortSignal.timeout(ms);
    const merged =
      init?.signal !== undefined && init.signal !== null
        ? AbortSignal.any([init.signal, t])
        : t;
    return fetch(input, { ...init, signal: merged });
  };
}

const countSupertrendFlips = (candles: Candle[], period: number, mult: number): number => {
  if (candles.length <= period + 2) return 0;
  const { dir } = supertrend(candles, period, mult);
  let flips = 0;
  for (let i = period + 1; i < dir.length; i++) {
    if (dir[i] !== dir[i - 1]) flips += 1;
  }
  return flips;
}

export const buildSupertrendTuneSnapshot = (symbol: string, timeframe: string, candles: Candle[], currentAtrPeriod: number, currentMultiplier: number): SupertrendTuneSnapshot | null => {
  if (candles.length < 60) return null;
  const tail = candles.length > 120 ? candles.slice(-120) : candles;
  const last = tail[tail.length - 1];
  if (!last || !Number.isFinite(last.close) || last.close === 0) return null;

  const last50 = tail.slice(-50);
  const highs = last50.map((c) => c.high);
  const lows = last50.map((c) => c.low);
  const rangeCompression50 = (Math.max(...highs) - Math.min(...lows)) / last.close;

  const closes = last50.map((c) => c.close);
  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i] - closes[i - 1]);
  }
  const mean = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
  const varSum = deltas.reduce((s, d) => s + (d - mean) ** 2, 0);
  const returnVolatility50 = Math.sqrt(varSum / Math.max(1, deltas.length));

  const baselineWindow = tail.length >= 60 ? tail.slice(-60) : tail;
  const baselineFlips50 = countSupertrendFlips(baselineWindow, DEFAULT_PERIOD, DEFAULT_MULT);

  return {
    symbol,
    timeframe,
    barCount: tail.length,
    lastClose: last.close,
    rangeCompression50: +rangeCompression50.toFixed(6),
    returnVolatility50: +returnVolatility50.toFixed(8),
    baselineFlips50,
    currentAtrPeriod,
    currentMultiplier,
  };
}

const extractJsonObject = (raw: string): string | null => {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

export const parseSupertrendTuneResponse = (raw: string): { atrPeriod: number; multiplier: number } | null => {
  const jsonStr = extractJsonObject(raw);
  if (!jsonStr) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(jsonStr) as unknown;
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const pRaw = rec.atrPeriod ?? rec.period;
  const mRaw = rec.multiplier ?? rec.mult;
  const atrPeriod = typeof pRaw === 'number' ? pRaw : typeof pRaw === 'string' ? Number.parseInt(pRaw, 10) : NaN;
  const multiplier = typeof mRaw === 'number' ? mRaw : typeof mRaw === 'string' ? Number.parseFloat(mRaw) : NaN;
  if (!Number.isFinite(atrPeriod) || !Number.isFinite(multiplier)) return null;
  const pi = Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.round(atrPeriod)));
  const mult = Math.min(MAX_MULT, Math.max(MIN_MULT, multiplier));
  return { atrPeriod: pi, multiplier: +mult.toFixed(4) };
}

export const requestSupertrendTune = async (cfg: OllamaSupertrendTuneConfig, snapshot: SupertrendTuneSnapshot): Promise<{ params: { atrPeriod: number; multiplier: number } | null; error: string | null }> => {
  const model = cfg.model.trim();
  if (!model) {
    return { params: null, error: 'missing_ollama_model' };
  }

  const host = cfg.host.trim() || 'http://127.0.0.1:11434';
  const key = cfg.apiKey?.trim();
  const headers: Record<string, string> | undefined =
    key && key.length > 0 ? { Authorization: `Bearer ${key}` } : undefined;

  const ollama = new Ollama({
    host,
    headers,
    fetch: createTimeoutFetch(cfg.timeoutMs),
  });

  try {
    const response = await ollama.chat({
      model,
      stream: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(snapshot) },
      ],
      options: {
        temperature: 0.15,
        num_ctx: cfg.contextSize,
        num_predict: 160,
      },
    });

    const text = response.message?.content?.trim() ?? '';
    if (!text) {
      return { params: null, error: 'empty_completion' };
    }
    const params = parseSupertrendTuneResponse(text);
    if (!params) {
      return { params: null, error: 'invalid_tune_json' };
    }
    return { params, error: null };
  } catch (e) {
    return { params: null, error: formatOllamaRequestError(e, cfg.timeoutMs) };
  }
}
