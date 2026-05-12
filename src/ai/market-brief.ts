/**
 * Ollama JS client for short narrative context on strategy signals.
 * Advisory only — does not drive execution.
 */

import { Ollama } from 'ollama';

export interface MarketSignalsSnapshot {
  symbol: string;
  refPrice: number;
  htfBias: string;
  ltfDirection: string;
  ltfConfidence: number;
  ltfScore?: number;
  ltfSignals?: unknown;
  smc?: {
    score: number;
    liquiditySweep?: string;
    orderBlock?: { type: string; low: number; high: number } | null;
    fvg?: { type: string } | null;
    bos?: string;
    choch?: string;
  };
  solMtf?: { pass: boolean; direction: string; reasons: string[] } | null;
}

export interface OllamaBriefConfig {
  host: string;
  model: string;
  timeoutMs: number;
  /** Bearer token when using Ollama Cloud. */
  apiKey?: string;
}

const SYSTEM_PROMPT = `You are a concise market-structure analyst assistant.
You receive JSON with indicator outputs from a local trading dashboard (HTF bias, LTF trend, SMC heuristics, optional multi-timeframe stack).
Write 4–6 short bullet lines: context, alignment or conflict between timeframes, what would strengthen or weaken the picture, and execution hygiene (wait for confirmation, avoid chasing).
Do not give buy/sell instructions or price targets. End with one line: "Not financial advice."
Keep total under 120 words. Plain text bullets using "- " prefix each line.`;

function buildUserContent(snapshot: MarketSignalsSnapshot): string {
  return JSON.stringify({
    symbol: snapshot.symbol,
    refPrice: snapshot.refPrice,
    htfBias: snapshot.htfBias,
    ltfDirection: snapshot.ltfDirection,
    ltfConfidence: snapshot.ltfConfidence,
    ltfScore: snapshot.ltfScore,
    ltfSignals: snapshot.ltfSignals,
    smc: snapshot.smc,
    solMtf: snapshot.solMtf,
  });
}

function createTimeoutFetch(timeoutMs: number): typeof fetch {
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

export async function requestMarketBrief(
  cfg: OllamaBriefConfig,
  snapshot: MarketSignalsSnapshot,
): Promise<{ text: string | null; error: string | null }> {
  const model = cfg.model.trim();
  if (!model) {
    return { text: null, error: 'missing_ollama_model' };
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
        { role: 'user', content: buildUserContent(snapshot) },
      ],
      options: {
        temperature: 0.25,
        num_predict: 400,
      },
    });

    const text = response.message?.content?.trim() ?? null;
    if (!text) {
      return { text: null, error: 'empty_completion' };
    }
    return { text, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { text: null, error: msg };
  }
}
