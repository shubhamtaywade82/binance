/**
 * NanoPine script generation via Ollama. Mounted by {@link createDashboardBridge}'s HTTP
 * handler — `POST /api/scripts/generate` takes `{ prompt: string }` and returns either
 *   200 { source: string, thinking?: string }
 *   503 { error: string }   // when the AI stack isn't configured
 *
 * Reuses the existing Ollama wiring (host / model / api key) from AppConfig.
 */
import { Ollama } from 'ollama';
import type http from 'http';
import type { AppConfig } from '../config';
import { ollamaApiUrl } from '../config';
import { formatOllamaRequestError } from '../ai/ollama-request-error';

const SYSTEM_PROMPT = `You are a code generator for NanoPine, a small Pine-script-like indicator DSL embedded in a Binance trading dashboard.

OUTPUT RULES (strict):
- Reply with the script source code only. No markdown code fences. No commentary. No prose before or after.
- Use the exact syntax below — anything else will fail to parse.

GRAMMAR
- One header per script: \`indicator("Name")\` OR \`indicator("Name", overlay=false)\` OR \`strategy("Name", initial_capital=10000)\`.
- Input declarations: \`name = input.int(default, title="...")\` (also \`input.float\` \`input.bool\` \`input.string\` \`input.source\`).
- Assignments: \`name = expression\`.
- Expression statements: \`plot(...)\`, \`plotshape(...)\`, \`hline(...)\`, \`bgcolor(...)\`, \`alert(...)\`, \`entry(...)\`, \`exit(...)\`.
- Series indexing: \`name[k]\` returns the value k bars ago. 0 is the current bar.
- Ternary: \`cond ? a : b\`.
- Comparators: \`== != < <= > >=\`. Booleans: \`and or not true false\`. \`na\` is NaN.

BUILT-IN SERIES
- \`open high low close volume hl2 hlc3 ohlc4\`

TA FUNCTIONS
- Moving averages: \`ema(src, len)\` \`sma(src, len)\` \`wma(src, len)\` \`vwma(src, len)\`.
- Oscillators: \`rsi(src, len)\` \`atr(len)\`.
- Statistics: \`stdev(src, len)\` \`sum(src, len)\`.
- Window extremes: \`highest(src, len)\` \`lowest(src, len)\`.
- Crosses: \`crossover(a, b)\` \`crossunder(a, b)\`.
- Trends: \`rising(src, len)\` \`falling(src, len)\` \`change(src)\`.
- Utility: \`nz(x, fallback)\` \`na(x)\` \`abs(x)\` \`max(a, b)\` \`min(a, b)\`.
- Multi-timeframe: \`security(tf, srcName)\` where tf is a string like "1m"/"5m"/"15m"/"1h"/"4h"/"1d" and srcName is one of "open"/"high"/"low"/"close"/"volume"/"hl2"/"hlc3"/"ohlc4". Returns the latest CLOSED higher-TF bar (no lookahead).

OUTPUT FUNCTIONS
- \`plot(value, color="#42a5f5", lineWidth=1, title="...", style="line"|"histogram"|"area", pane=0|1)\` — pane=1 routes to the sub-pane below the price.
- \`plotshape(cond, location="belowbar"|"abovebar", color="...", shape="triangleup"|"triangledown"|"circle"|"square"|"cross", title="...")\`
- \`hline(price, color="...", title="...")\`
- \`bgcolor(color, opacity=0.2)\` — pass \`na\` as color to skip a bar.
- \`alert(cond, "message text")\` — fires when cond is truthy.

STRATEGY-ONLY
- \`entry(cond, "long"|"short", qty=1)\`
- \`exit(cond)\`

CONSTRAINTS
- No loops (no for, no while, no recursion).
- No function definitions.
- No member access — \`a.b\` is illegal.
- TA function \`len\` arguments must be a constant or an \`input.int\` (not a runtime-varying expression).
- Use double-quoted strings only.

REFERENCE — minimal valid script:
indicator("Sample")
fastLen = input.int(9, title="Fast")
slowLen = input.int(21, title="Slow")
fast = ema(close, fastLen)
slow = ema(close, slowLen)
plot(fast, color="lime", title="Fast")
plot(slow, color="magenta", title="Slow")
plotshape(crossover(fast, slow), location="belowbar", color="lime", shape="triangleup", title="buy")

If the user asks for something that can't be expressed in this DSL (e.g. arrays, multiple positions, custom functions), produce the closest valid approximation and add no comments.`;

export interface ScriptsAiOptions {
  cfg: AppConfig;
}

export interface ScriptsAiApi {
  enabled: boolean;
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
}

const MAX_PROMPT_BYTES = 8 * 1024;

export function createScriptsAi(opts: ScriptsAiOptions): ScriptsAiApi {
  const { cfg } = opts;
  const model = (cfg.OLLAMA_MODEL || '').trim();
  const host =
    cfg.OLLAMA_TARGET === 'cloud'
      ? ollamaApiUrl('cloud')
      : ollamaApiUrl('local');
  const apiKey = (cfg.OLLAMA_API_KEY || '').trim();
  const enabled = model.length > 0;

  const sendJson = (
    res: http.ServerResponse,
    statusCode: number,
    body: unknown,
  ): void => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let total = 0;
      let aborted = false;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > MAX_PROMPT_BYTES) aborted = true;
        else chunks.push(chunk);
      });
      req.on('end', () => {
        if (aborted) reject(new Error('payload too large'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      req.on('error', reject);
    });

  return {
    enabled,
    handle: async (req, res) => {
      const url = req.url ?? '';
      if (url !== '/api/scripts/generate') return false;
      const method = (req.method ?? 'GET').toUpperCase();
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'POST required' });
        return true;
      }
      if (!enabled) {
        sendJson(res, 503, {
          error:
            'AI generation not configured. Set OLLAMA_MODEL and (for cloud) OLLAMA_API_KEY in .env.',
        });
        return true;
      }
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
        if (!prompt) {
          sendJson(res, 400, { error: 'Missing "prompt" string in body' });
          return true;
        }
        const headers: Record<string, string> | undefined =
          apiKey.length > 0 ? { Authorization: `Bearer ${apiKey}` } : undefined;
        res.setTimeout(0);
        const ollama = new Ollama({ host, headers });
        const response = await ollama.chat({
          model,
          stream: false,
          think: false,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Write a NanoPine script that does the following:\n\n${prompt}`,
            },
          ],
          options: {
            temperature: 0.2,
            num_ctx: cfg.AI_CONTEXT_SIZE,
            num_predict: 1024,
          },
        });
        const content =
          typeof response?.message?.content === 'string'
            ? response.message.content.trim()
            : '';
        if (!content) {
          sendJson(res, 502, {
            error: 'Ollama returned empty content. Check OLLAMA_MODEL is installed.',
          });
          return true;
        }
        const source = stripCodeFence(content);
        sendJson(res, 200, { source, model });
      } catch (err) {
        sendJson(res, 500, {
          error: formatOllamaRequestError(err, cfg.AI_REQUEST_TIMEOUT_MS),
        });
      }
      return true;
    },
  };
}

// Model may wrap output in ```nanopine ... ``` despite the system prompt; strip it.
function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fence = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) return fence[1].trim();
  return trimmed;
}
