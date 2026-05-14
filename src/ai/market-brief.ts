/**
 * Ollama JS client for short narrative context on strategy signals.
 * Advisory only — does not drive execution.
 */

import { Ollama, type ChatRequest } from 'ollama';
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
  /**
   * When true, request extended thinking (`think: true` on `/api/chat`).
   * Uses more tokens; pair with {@link streamEnabled} to stream reasoning + answer.
   */
  thinkEnabled?: boolean;
  /**
   * When true, use Ollama streaming; {@link onStreamChunk} receives cumulative deltas
   * after each chunk (excluding the terminal `done` frame — caller uses the return value).
   */
  streamEnabled?: boolean;
  /** Invoked during streaming (not on the final `done` chunk). */
  onStreamChunk?: (p: { content: string; thinking: string }) => void;
}

export interface MarketBriefResult {
  text: string | null;
  /** Raw reasoning text when the model used a separate thinking channel. */
  thinking: string | null;
  error: string | null;
}

const SYSTEM_PROMPT_THINKING_ALLOWED = `You are a concise market-structure analyst assistant.
You receive JSON with indicator outputs from a local trading dashboard (HTF bias, LTF trend, SMC heuristics, optional multi-timeframe stack).

If the host exposes a reasoning channel, use it for scratch work only. The **assistant message body** must be GitHub-flavored Markdown for the trader (no HTML tags):
- Start with a ## heading (e.g. "## Brief" or "## Snapshot").
- Use short paragraphs and/or bullet lists with "- ".
- Bold key labels inline, e.g. **Context:**, **Alignment:**, **Conflict:**, **Execution:**.
- Mention directions like SHORT/LONG in **bold** when they matter.
- Use \`TICKER\` backticks for the symbol when you reference it.
- Do not give buy/sell instructions or price targets.
- End with a separate line: *Not financial advice.*
Keep total under 140 words.`;

const SYSTEM_PROMPT_NO_EXTENDED_THINK = `You are a concise market-structure analyst assistant.
You receive JSON with indicator outputs from a local trading dashboard (HTF bias, LTF trend, SMC heuristics, optional multi-timeframe stack).

Output only the brief below — no separate chain-of-thought, analysis steps, or hidden reasoning blocks.

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
};

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
};

const MAX_THINKING_FALLBACK_CHARS = 12_000;

/** Enough headroom for brief markdown after optional reasoning tokens. */
const BRIEF_NUM_PREDICT = 1024;

const sliceThinking = (raw: string): string => {
  const t = raw.trim();
  if (t.length <= MAX_THINKING_FALLBACK_CHARS) return t;
  return `${t.slice(0, MAX_THINKING_FALLBACK_CHARS)}\n\n…`;
};

const extractMessageStrings = (part: unknown): { content: string; thinking: string } => {
  if (part === null || typeof part !== 'object') return { content: '', thinking: '' };
  const r = part as Record<string, unknown>;
  const msg = r.message;
  if (msg === null || typeof msg !== 'object') return { content: '', thinking: '' };
  const m = msg as Record<string, unknown>;
  const content = typeof m.content === 'string' ? m.content : '';
  const thinkingMsg = typeof m.thinking === 'string' ? m.thinking : '';
  const thinkingRoot = typeof r.thinking === 'string' ? r.thinking : '';
  return { content, thinking: thinkingMsg.length > 0 ? thinkingMsg : thinkingRoot };
};

const finalizeBriefText = (
  contentAcc: string,
  thinkingAcc: string,
  thinkEnabled: boolean,
): { text: string | null; thinking: string | null } => {
  const c = contentAcc.trim();
  const th = thinkingAcc.trim();
  if (c.length > 0) {
    return { text: c, thinking: thinkEnabled && th.length > 0 ? th : null };
  }
  if (th.length > 0) {
    if (thinkEnabled) {
      return {
        text: '## Brief\n\n_Model produced reasoning only; see **Reasoning** below._\n\n*Not financial advice.*',
        thinking: th,
      };
    }
    const body = sliceThinking(th);
    return {
      text: `## Brief\n\n_(This model returned reasoning in a separate field; consider **AI_BRIEF_THINK_ENABLED=true** or a standard chat model.)_\n\n${body}`,
      thinking: null,
    };
  }
  return { text: null, thinking: null };
};

const emptyCompletionHint = (response: unknown, model: string): string => {
  const r = response !== null && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const dr = r.done_reason != null ? String(r.done_reason) : '?';
  const ec = r.eval_count != null ? String(r.eval_count) : '?';
  const respModel = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : model;
  return (
    `empty_completion — Ollama returned no assistant text (model=${respModel}, done_reason=${dr}, eval_count=${ec}). ` +
    `Confirm OLLAMA_MODEL matches an installed name from \`ollama list\`, run \`ollama pull ${model}\`, and try \`ollama run ${model} "Reply with one word: OK"\`. ` +
    'Try **AI_BRIEF_THINK_ENABLED=true** + **AI_BRIEF_STREAM_ENABLED=true**, raise **AI_REQUEST_TIMEOUT_MS**, or use a non-thinking model. ' +
    'If you use Ollama on Windows while the bot runs in WSL, point the client at the Windows host IP instead of 127.0.0.1.'
  );
};

const chatRequestShared = (
  model: string,
  thinkEnabled: boolean,
  userJson: string,
): Pick<ChatRequest, 'model' | 'think' | 'messages' | 'options'> => {
  const system = thinkEnabled ? SYSTEM_PROMPT_THINKING_ALLOWED : SYSTEM_PROMPT_NO_EXTENDED_THINK;
  return {
    model,
    think: thinkEnabled ? true : false,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userJson },
    ],
    options: {
      temperature: 0.25,
      num_predict: BRIEF_NUM_PREDICT,
    },
  };
};

export const requestMarketBrief = async (
  cfg: OllamaBriefConfig,
  snapshot: MarketSignalsSnapshot,
): Promise<MarketBriefResult> => {
  const model = cfg.model.trim();
  if (!model) {
    return { text: null, thinking: null, error: 'missing_ollama_model' };
  }

  const thinkEnabled = cfg.thinkEnabled === true;
  const streamEnabled = cfg.streamEnabled === true;
  const userJson = buildUserContent(snapshot);

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
    if (streamEnabled) {
      const stream = await ollama.chat({
        ...chatRequestShared(model, thinkEnabled, userJson),
        stream: true,
      });
      let contentAcc = '';
      let thinkingAcc = '';
      let lastPart: unknown = null;
      for await (const part of stream) {
        lastPart = part;
        const { content, thinking } = extractMessageStrings(part);
        if (content.length > 0) contentAcc += content;
        if (thinking.length > 0) thinkingAcc += thinking;
        const done = (part as { done?: boolean }).done === true;
        if (!done) {
          cfg.onStreamChunk?.({ content: contentAcc, thinking: thinkingAcc });
        }
      }
      const { text, thinking } = finalizeBriefText(contentAcc, thinkingAcc, thinkEnabled);
      if (!text) {
        return { text: null, thinking: null, error: emptyCompletionHint(lastPart, model) };
      }
      return { text, thinking, error: null };
    }

    const response = await ollama.chat({
      ...chatRequestShared(model, thinkEnabled, userJson),
      stream: false,
    });
    const { content, thinking } = extractMessageStrings(response);
    const { text, thinking: thOut } = finalizeBriefText(content, thinking, thinkEnabled);
    if (!text) {
      return { text: null, thinking: null, error: emptyCompletionHint(response, model) };
    }
    return { text, thinking: thOut, error: null };
  } catch (e) {
    return { text: null, thinking: null, error: formatOllamaRequestError(e, cfg.timeoutMs) };
  }
};
