/**
 * Ollama JS client for short narrative context on strategy signals.
 * Advisory only — does not drive execution.
 */

import { Ollama } from 'ollama';
import { formatOllamaRequestError } from './ollama-request-error';

export interface MarketSignalsSnapshot {
  symbol: string;
  refPrice: number;
  /** Chart timeframe used for `refPrice` (aligned with UI selection). */
  refPriceTf?: string;
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

Respond in GitHub-flavored Markdown only (no HTML tags):
- Start with a ## heading (e.g. "## Brief" or "## Snapshot").
- Use short paragraphs and/or bullet lists with "- ".
- Bold key labels inline, e.g. **Context:**, **Alignment:**, **Conflict:**, **Execution:**.
- Mention directions like SHORT/LONG in **bold** when they matter.
- Use \`TICKER\` backticks for the symbol when you reference it.
- Do not give buy/sell instructions or price targets.
- End with a separate line: *Not financial advice.*
Keep total under 140 words.`;

const buildUserContent = (snapshot: MarketSignalsSnapshot): string => {
  return JSON.stringify({
    symbol: snapshot.symbol,
    refPrice: snapshot.refPrice,
    refPriceTf: snapshot.refPriceTf,
    htfBias: snapshot.htfBias,
    ltfDirection: snapshot.ltfDirection,
    ltfConfidence: snapshot.ltfConfidence,
    ltfScore: snapshot.ltfScore,
    ltfSignals: snapshot.ltfSignals,
    smc: snapshot.smc,
    solMtf: snapshot.solMtf,
  });
}

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

const MAX_THINKING_FALLBACK_CHARS = 12_000;

/** Ollama `/api/chat` JSON shape varies by server version and model (e.g. thinking models). */
const pickAssistantTextFromChatResponse = (response: unknown): string | null => {
  if (response === null || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  const msg = r.message;
  if (msg === null || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  const content = typeof m.content === 'string' ? m.content.trim() : '';
  if (content.length > 0) return content;
  const thinkingRaw = typeof m.thinking === 'string' ? m.thinking.trim() : '';
  if (thinkingRaw.length === 0) return null;
  const thinking =
    thinkingRaw.length > MAX_THINKING_FALLBACK_CHARS
      ? `${thinkingRaw.slice(0, MAX_THINKING_FALLBACK_CHARS)}\n\n…`
      : thinkingRaw;
  return `## Brief\n\n_(This model returned reasoning in a separate field; consider a standard chat model for cleaner briefs.)_\n\n${thinking}`;
};

const emptyCompletionHint = (response: unknown, model: string): string => {
  const r = response !== null && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const dr = r.done_reason != null ? String(r.done_reason) : '?';
  const ec = r.eval_count != null ? String(r.eval_count) : '?';
  const respModel = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : model;
  return (
    `empty_completion — Ollama returned no assistant text (model=${respModel}, done_reason=${dr}, eval_count=${ec}). ` +
    `Confirm OLLAMA_MODEL matches an installed name from \`ollama list\`, run \`ollama pull ${model}\`, and try \`ollama run ${model} "Reply with one word: OK"\`. ` +
    'If you use Ollama on Windows while the bot runs in WSL, point the client at the Windows host IP instead of 127.0.0.1.'
  );
};

export const requestMarketBrief = async (cfg: OllamaBriefConfig, snapshot: MarketSignalsSnapshot): Promise<{ text: string | null; error: string | null }> => {
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

    const text = pickAssistantTextFromChatResponse(response);
    if (!text) {
      return { text: null, error: emptyCompletionHint(response, model) };
    }
    return { text, error: null };
  } catch (e) {
    return { text: null, error: formatOllamaRequestError(e, cfg.timeoutMs) };
  }
}
