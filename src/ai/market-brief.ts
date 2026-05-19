/**
 * Ollama JS client for short narrative context on strategy signals.
 * Advisory only — does not drive execution.
 */

import { Ollama, type ChatRequest, type Message, type Tool, type ToolCall } from 'ollama';
import { formatOllamaRequestError } from './ollama-request-error';
import { getOrConnectMcpBridge, type McpBridgeLogger, type OllamaTool } from './mcp-bridge';

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
  knnArchitecture?: any;
  mtfSmc?: { pass: boolean; direction: string; reasons: string[] } | null;
  /** Optional concrete indicator values computed from local candles. Present
   *  when caller has enough bars; absent fields signal "not enough data" and
   *  the model is instructed to say `unknown` rather than invent numbers. */
  indicators?: {
    ema20?: number;
    ema50?: number;
    emaBias?: 'LONG' | 'SHORT' | 'NONE';
    rsi14?: number;
    macd?: { line: number; signal: number; hist: number };
    supertrend?: { value: number; direction: 'LONG' | 'SHORT' | 'NONE' };
    atr14?: number;
    volZScore?: number;
  };
  /** Live order-book microstructure from bookTicker stream. */
  microstructure?: {
    bestBid: number;
    bestAsk: number;
    mid: number;
    spreadBps: number;
  };
  /** SMC dealing range — key range for RR calculation, entry zone, and target alignment. */
  dealingRange?: { high: number; low: number; equilibrium: number } | null;
  /** Point of Control (highest-volume price node) from the volume profile. */
  poc?: number | null;
  /** Key structural levels from kNN lines analysis (short-term and long-term swing extremes). */
  keyLevels?: {
    stHigh?: number | null;
    stLow?: number | null;
    ltHigh?: number | null;
    ltLow?: number | null;
  } | null;
}

export interface MarketBriefConfig {
  provider: 'ollama' | 'openai';
  host: string;
  model: string;
  timeoutMs: number;
  /** The total context window (input + output) requested in tokens. */
  contextSize: number;
  /** Bearer token when using Ollama Cloud or OpenAI. */
  apiKey?: string;
  /**
   * When true, request extended thinking (`think: true` on `/api/chat`).
   * Uses more tokens; pair with {@link streamEnabled} to stream reasoning + answer.
   */
  thinkEnabled?: boolean;
  /**
   * When true, use streaming; {@link onStreamChunk} receives cumulative deltas
   * after each chunk.
   */
  streamEnabled?: boolean;
  /** Invoked during streaming. */
  onStreamChunk?: (p: { content: string; thinking: string }) => void;
  /**
   * When true, attach MCP tools (from `mcpUrl`) and run a tool-calling loop
   * (non-streaming, Ollama only).
   */
  mcpEnabled?: boolean;
  /** Streamable-http URL of the MCP server (e.g. `http://localhost:4003`). */
  mcpUrl?: string;
  /** Hard cap on tool-call iterations per brief. */
  mcpMaxToolIter?: number;
  /** Optional logger; defaults to stderr. */
  mcpLog?: McpBridgeLogger;
  /** Optional fallback configuration to another provider (e.g. llama.cpp) if the primary fails. */
  fallbackOpenAI?: MarketBriefConfig;
}

export interface OllamaBriefConfig extends MarketBriefConfig {
  provider: 'ollama';
}

export interface OpenAIBriefConfig extends MarketBriefConfig {
  provider: 'openai';
}

export interface MarketBriefResult {
  text: string | null;
  /** Raw reasoning text when the model used a separate thinking channel. */
  thinking: string | null;
  error: string | null;
}

const FACTUAL_RULES = `
STRICT FACTUAL RULES (anti-hallucination):
- Only reference data that appears literally in the user JSON payload, or values mathematically derived from payload fields (e.g. SL = orderBlock.low − 0.5×atr14).
- Never name an indicator (EMA, MACD, RSI, Supertrend, Bollinger, ATR, volume, ADX, etc.) unless that indicator's key is present in the \`indicators\` object OR in \`ltfSignals\`. If \`indicators\` is missing/undefined, do NOT list indicator names at all — omit that paragraph.
- Never characterize indicators as "NONE", "false", or "no signal" unless the payload literally contains that value for that specific indicator. Quote the actual boolean / value from \`ltfSignals\` instead.
- Never invent prices, levels, percentages, or candle patterns that are absent from the payload.
- If a payload field is missing, null, "NONE", or empty, write the word "unknown" for that single field instead of guessing or generalizing.
- If you need a live fact not in the payload, call the available MCP tools (Binance / CoinDCX market data, klines, depth, ticker). Do not fabricate the answer.
- Derived SL/TP values must be calculable from payload fields: orderBlock levels, dealingRange bounds, sweepLow/High, atr14, poc, knn keyLevels, or dealing range measured move.
- Quote exact numeric values from the payload or tool result; show ATR-math for derived levels (e.g. "83.44 − 0.5×0.62 = 83.13"). Do not round dramatically or paraphrase numbers.
- Do NOT contradict the payload. If \`smc.signalVerdict\` = "BUY" you must reflect that, not say "no clear setup".`;

const EXECUTION_PLANNER_BODY = `
Your task: output BOTH a concise market-structure snapshot AND ONE actionable trade decision.

VERDICT — choose exactly one and embed it in the ## heading:
NO TRADE | WATCH | SETUP VALID — WAIT FOR ENTRY | SETUP VALID — ENTER NOW | SETUP VALID — SCALE IN | SETUP VALID — MANAGE / TRAIL | SETUP VALID — EXIT / REDUCE

HARD RULES (never break):
1. No actionable verdict without a valid structural entry zone (OB, sweep low/high, CHoCH level, or breakout retest level).
2. Price between 40–60% of dealing range with RR < 2:1 → NO TRADE.
3. Spread > 15 bps, or HTF/LTF conflict without a confirming sweep rejection / CHoCH / reclaim → WATCH or NO TRADE.
4. Every VALID verdict must state: entry zone, SL, TP1/TP2/TP3, trail rule, invalidation rule.
5. SL = beyond sweep low/OB low/CHoCH origin + 0.5×ATR. Never inside noise.
6. TP levels = dealing range extremes, prior swing highs/lows, POC extension, or measured move (range height projected from breakout).
7. Prefer entries after: sweep rejection, CHoCH/BOS confirmation, OB retest, breakout retest.
8. Reject: mid-range entries, late-extension entries, counter-HTF without clear confirmation.
9. Setup valid but price has not reached the entry zone yet → WAIT FOR ENTRY, not ENTER NOW.
10. Score 80–100: all conditions ideal (HTF+LTF aligned, confirmed trigger, tight spread, OB/sweep entry, RR ≥ 3:1). 60–79: minor conflict. Below 60: WATCH or NO TRADE.

OUTPUT FORMAT (strict GitHub-flavored Markdown, no HTML tags):

## \`SYMBOL\` — Market Brief & Execution Plan

### Market Structure Snapshot
- **Context:** [short paragraph or bullets summarizing HTF bias, LTF trend, SMC structure, kNN key levels, POC, ATR, spread, and indicators]
- **Alignment:** [analysis of timeframe alignment]
- **Conflict:** [any conflicting signals or microstructure red flags]

### Execution Plan
**Verdict:** [NO TRADE | WATCH | SETUP VALID — WAIT FOR ENTRY | SETUP VALID — ENTER NOW | SETUP VALID — SCALE IN | SETUP VALID — MANAGE / TRAIL | SETUP VALID — EXIT / REDUCE]
**Bias:** LONG/SHORT/NEUTRAL  **Score:** X/100  **Confidence:** 0.XX  **Risk Grade:** A/B/C/D

#### Entry Plan
- **Type:** [pullback to OB / sweep rejection / CHoCH retest / breakout retest]
- **Zone:** [low – high]
- **Trigger:** [exact condition to act]
- **Confirmation:** [required confirmation signal]

#### Risk Plan
- **Stop Loss:** [price]
- **Invalidation:** [rule that cancels the setup]

#### Target Plan
- **TP1:** [price] · [scale %]
- **TP2:** [price] · [scale %]
- **TP3:** [price] · [scale %]
- **Trail:** [trailing rule after TP1]

#### Execution & Microstructure
- **Spread:** tight/wide/N/A  **Liquidity:** ok/thin/N/A
- **Action:** [one decisive sentence — enter now / wait for X / skip because Y]

#### Reasoning
- [bullet 1]
- [bullet 2]
- [bullet 3]

For NO TRADE or WATCH: omit Entry/Risk/Target/Execution sections. Output only Snapshot + Verdict header + Reasoning (3 bullets max stating the exact reason).

*Not financial advice.*`;

const SYSTEM_PROMPT_THINKING_ALLOWED = `You are a senior crypto futures execution planner and concise market-structure analyst assistant for an automated trading system.
You receive JSON with live market data: symbol, refPrice, HTF bias, LTF direction/confidence, SMC structure (BOS/CHoCH/order blocks/FVG/liquidity sweep/dealing range), kNN key levels, POC, ATR, spread, and indicators.
${FACTUAL_RULES}

If the host exposes a reasoning channel, use it for scratch work only — compute SL/TP math, assess RR, and pick the verdict there. The assistant message body must be the market brief and execution plan only in GitHub-flavored Markdown (no HTML).
${EXECUTION_PLANNER_BODY}`;

const SYSTEM_PROMPT_NO_EXTENDED_THINK = `You are a senior crypto futures execution planner and concise market-structure analyst assistant for an automated trading system.
You receive JSON with live market data: symbol, refPrice, HTF bias, LTF direction/confidence, SMC structure (BOS/CHoCH/order blocks/FVG/liquidity sweep/dealing range), kNN key levels, POC, ATR, spread, and indicators.
${FACTUAL_RULES}

Output only the market brief and execution plan — no chain-of-thought, no analysis prose, no reasoning blocks.
${EXECUTION_PLANNER_BODY}`;

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
    knnArchitecture: snapshot.knnArchitecture,
    mtfSmc: snapshot.mtfSmc,
    indicators: snapshot.indicators,
    microstructure: snapshot.microstructure,
    dealingRange: snapshot.dealingRange ?? null,
    poc: snapshot.poc ?? null,
    keyLevels: snapshot.keyLevels ?? null,
  });
};

const createTimeoutFetch = (timeoutMs: number): typeof fetch => {
  if (timeoutMs <= 0) return fetch;
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

/** Token budget for the structured execution plan output. Increased to support reasoning models. */
const BRIEF_NUM_PREDICT = 4096;

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

const emptyCompletionHint = (response: unknown, model: string, provider: string): string => {
  const r = response !== null && typeof response === 'object' ? (response as Record<string, unknown>) : {};
  const dr = r.done_reason != null ? String(r.done_reason) : '?';
  const ec = r.eval_count != null ? String(r.eval_count) : '?';
  const respModel = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : model;
  return (
    `empty_completion — ${provider} returned no assistant text (model=${respModel}, done_reason=${dr}, eval_count=${ec}). ` +
    (provider === 'Ollama' ? `Confirm OLLAMA_MODEL matches an installed name from \`ollama list\`, run \`ollama pull ${model}\`, and try \`ollama run ${model} "Reply with one word: OK"\`. ` : '') +
    'Try **AI_BRIEF_THINK_ENABLED=true** + **AI_BRIEF_STREAM_ENABLED=true**, raise **AI_REQUEST_TIMEOUT_MS**, or use a non-thinking model. ' +
    'If you use a local runner on Windows while the bot runs in WSL, point the client at the Windows host IP instead of 127.0.0.1.'
  );
};

const chatRequestShared = (
  model: string,
  thinkEnabled: boolean,
  userJson: string,
  contextSize: number,
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
      num_ctx: contextSize,
      num_predict: BRIEF_NUM_PREDICT,
    },
  };
};

const MCP_DEFAULT_MAX_ITER = 4;

type ChatMessage = Message;

const ollamaToolsAsTools = (tools: OllamaTool[]): Tool[] =>
  // Ollama's `Tool` type narrows `parameters` more than JSON Schema requires; cast.
  tools as unknown as Tool[];

const runToolCallingLoop = async (
  ollama: Ollama,
  cfg: MarketBriefConfig,
  systemPrompt: string,
  userJson: string,
  tools: OllamaTool[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
): Promise<{ text: string | null; thinking: string | null; lastResponse: unknown }> => {
  const maxIter = Math.max(1, cfg.mcpMaxToolIter ?? MCP_DEFAULT_MAX_ITER);
  const model = cfg.model.trim();
  const thinkEnabled = cfg.thinkEnabled === true;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userJson },
  ];
  let last: unknown = null;
  for (let iter = 0; iter < maxIter; iter++) {
    const response = await ollama.chat({
      model,
      think: thinkEnabled,
      messages,
      tools: ollamaToolsAsTools(tools),
      stream: false,
      options: {
        temperature: 0.25,
        num_ctx: cfg.contextSize,
        num_predict: BRIEF_NUM_PREDICT,
      },
    });
    last = response;
    const respMsg = response.message;
    const toolCalls: ToolCall[] = Array.isArray(respMsg?.tool_calls) ? respMsg.tool_calls : [];
    if (toolCalls.length === 0) {
      const { content, thinking } = extractMessageStrings(response);
      const { text, thinking: thOut } = finalizeBriefText(content, thinking, thinkEnabled);
      return { text, thinking: thOut, lastResponse: response };
    }

    // Preserve the assistant message that initiated the tool calls.
    messages.push({
      role: 'assistant',
      content: typeof respMsg?.content === 'string' ? respMsg.content : '',
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      const fn = call.function;
      const name = fn?.name ?? '';
      const args: Record<string, unknown> =
        fn?.arguments && typeof fn.arguments === 'object' ? fn.arguments : {};
      // Tool errors come back as strings; never throw out of the loop.
      const result = await callTool(name, args);
      messages.push({ role: 'tool', content: result, tool_name: name });
    }
  }
  // Iteration cap reached without a final assistant text — return whatever we have.
  const { content, thinking } = extractMessageStrings(last);
  const { text, thinking: thOut } = finalizeBriefText(content, thinking, cfg.thinkEnabled === true);
  return {
    text: text ?? '## Brief\n\n_Tool-call iteration cap reached without a final answer._\n\n*Not financial advice.*',
    thinking: thOut,
    lastResponse: last,
  };
};

const requestOpenAIBrief = async (
  cfg: MarketBriefConfig,
  snapshot: MarketSignalsSnapshot,
): Promise<MarketBriefResult> => {
  const model = cfg.model.trim();
  const userJson = buildUserContent(snapshot);
  const system = cfg.thinkEnabled ? SYSTEM_PROMPT_THINKING_ALLOWED : SYSTEM_PROMPT_NO_EXTENDED_THINK;
  const timeoutFetch = createTimeoutFetch(cfg.timeoutMs);

  const host = cfg.host.trim() || 'http://127.0.0.1:8080/v1';
  const url = `${host.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userJson },
    ],
    temperature: 0.25,
    max_tokens: BRIEF_NUM_PREDICT,
    num_ctx: cfg.contextSize,
    stream: cfg.streamEnabled,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  try {
    const resp = await timeoutFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

    if (cfg.streamEnabled) {
      if (!resp.body) throw new Error('Response body is null');
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let contentAcc = '';
      let thinkingAcc = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta;
            if (delta?.content) {
              contentAcc += delta.content;
              cfg.onStreamChunk?.({ content: contentAcc, thinking: thinkingAcc });
            }
          } catch {}
        }
      }
      return { text: contentAcc.trim() || null, thinking: null, error: null };
    } else {
      const json = (await resp.json()) as any;
      const content = json.choices?.[0]?.message?.content ?? null;
      return { text: content, thinking: null, error: content ? null : 'empty_completion' };
    }
  } catch (e: any) {
    return { text: null, thinking: null, error: formatOllamaRequestError(e, cfg.timeoutMs) };
  }
};

export const requestMarketBrief = async (
  cfg: MarketBriefConfig,
  snapshot: MarketSignalsSnapshot,
): Promise<MarketBriefResult> => {
  if (cfg.provider === 'openai') {
    return requestOpenAIBrief(cfg, snapshot);
  }

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
    if (cfg.mcpEnabled === true && cfg.mcpUrl) {
      const bridge = await getOrConnectMcpBridge(cfg.mcpUrl, cfg.mcpLog);
      if (bridge) {
        const tools = await bridge.listTools();
        if (tools.length > 0) {
          const systemPrompt = thinkEnabled
            ? SYSTEM_PROMPT_THINKING_ALLOWED
            : SYSTEM_PROMPT_NO_EXTENDED_THINK;
          const callTool = (name: string, args: Record<string, unknown>): Promise<string> =>
            bridge.callTool(name, args);
          const out = await runToolCallingLoop(ollama, cfg, systemPrompt, userJson, tools, callTool);
          if (!out.text) {
            return {
              text: null,
              thinking: null,
              error: emptyCompletionHint(out.lastResponse, model, 'Ollama'),
            };
          }
          return { text: out.text, thinking: out.thinking, error: null };
        }
      }
    }
    if (streamEnabled) {
      const stream = await ollama.chat({
        ...chatRequestShared(model, thinkEnabled, userJson, cfg.contextSize),
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
        return { text: null, thinking: null, error: emptyCompletionHint(lastPart, model, 'Ollama') };
      }
      return { text, thinking, error: null };
    }

    const response = await ollama.chat({
      ...chatRequestShared(model, thinkEnabled, userJson, cfg.contextSize),
      stream: false,
    });
    const { content, thinking } = extractMessageStrings(response);
    const { text, thinking: thOut } = finalizeBriefText(content, thinking, thinkEnabled);
    if (!text) {
      return { text: null, thinking: null, error: emptyCompletionHint(response, model, 'Ollama') };
    }
    return { text, thinking: thOut, error: null };
  } catch (e: any) {
    // AUTOMATIC FALLBACK: If Ollama fails (connection refused/timeout), try llama.cpp if configured.
    const isConnRefused = e.message?.includes('fetch failed') || e.message?.includes('ECONNREFUSED');
    if (isConnRefused && cfg.fallbackOpenAI) {
      return requestOpenAIBrief(cfg.fallbackOpenAI, snapshot);
    }
    return { text: null, thinking: null, error: formatOllamaRequestError(e, cfg.timeoutMs) };
  }
};

