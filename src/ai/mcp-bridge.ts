/**
 * Bridge from the in-app AI (Ollama tool-calling) to the MCP server that
 * exposes Binance + CoinDCX public market data tools.
 *
 * Connects via the MCP TypeScript SDK using `streamable-http` (preferred) and
 * falls back to SSE if streamable transport rejects.
 *
 * Tools are converted to Ollama's OpenAI-compatible function-calling schema.
 *
 * The bridge is resilient: a failed `listTools()`/`callTool()` returns a
 * harmless empty list / error string respectively so a single MCP failure
 * never aborts a market brief.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/** Minimal logger shape — compatible with the app's `AppLogger`. */
export interface McpBridgeLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const fallbackLogger: McpBridgeLogger = {
  info: (msg, meta) => process.stderr.write(`${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  warn: (msg, meta) => process.stderr.write(`${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
};

/** OpenAI-style function-calling tool entry that Ollama also accepts. */
export interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const TOOL_CACHE_TTL_MS = 60_000;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const toJsonSchemaParams = (input: unknown): Record<string, unknown> => {
  if (isObject(input)) {
    // The MCP SDK returns JSON Schema objects directly; pass through unchanged
    // (Ollama / OpenAI accept JSON Schema verbatim).
    return input;
  }
  return { type: 'object', properties: {}, additionalProperties: true };
};

const mcpToolToOllama = (tool: ToolDef): OllamaTool => {
  const desc = (tool.description ?? '').trim() || `MCP tool ${tool.name}`;
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: desc.length > 1024 ? desc.slice(0, 1024) : desc,
      parameters: toJsonSchemaParams(tool.inputSchema),
    },
  };
};

const stringifyToolContent = (content: unknown, structured: unknown): string => {
  const parts: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block)) continue;
      const text = typeof block.text === 'string' ? block.text : '';
      if (text) parts.push(text);
    }
  }
  if (structured !== undefined && structured !== null) {
    try {
      const json = JSON.stringify(structured);
      // Keep payload bounded; large dumps blow Ollama's context.
      const slice = json.length > 8000 ? json.slice(0, 8000) + '…' : json;
      parts.push(slice);
    } catch {
      /* ignore non-serialisable structured output */
    }
  }
  const joined = parts.join('\n').trim();
  return joined.length ? joined : '(empty tool response)';
};

interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: ToolDef[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

/** Constructs MCP SDK objects. Overridable for tests. */
export interface McpBridgeDeps {
  createClient?: () => McpClientLike;
  createStreamableTransport?: (url: URL) => unknown;
  createSseTransport?: (url: URL) => unknown;
  now?: () => number;
  log?: McpBridgeLogger;
  timeoutMs?: number;
  toolCacheTtlMs?: number;
}

const defaultDeps = (): Required<Omit<McpBridgeDeps, 'log'>> & { log: McpBridgeLogger } => ({
  createClient: () =>
    new Client({ name: 'coindcx-binance-bot', version: '0.1.0' }) as unknown as McpClientLike,
  createStreamableTransport: (url: URL) => new StreamableHTTPClientTransport(url),
  createSseTransport: (url: URL) => new SSEClientTransport(url),
  now: () => Date.now(),
  log: fallbackLogger,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  toolCacheTtlMs: TOOL_CACHE_TTL_MS,
});

const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export class McpBridge {
  private readonly deps: ReturnType<typeof defaultDeps>;
  private client: McpClientLike | null = null;
  private connectedUrl: string | null = null;
  private toolCache: { tools: OllamaTool[]; expiresAt: number } | null = null;

  constructor(deps: McpBridgeDeps = {}) {
    const d = defaultDeps();
    this.deps = {
      createClient: deps.createClient ?? d.createClient,
      createStreamableTransport: deps.createStreamableTransport ?? d.createStreamableTransport,
      createSseTransport: deps.createSseTransport ?? d.createSseTransport,
      now: deps.now ?? d.now,
      log: deps.log ?? d.log,
      timeoutMs: deps.timeoutMs ?? d.timeoutMs,
      toolCacheTtlMs: deps.toolCacheTtlMs ?? d.toolCacheTtlMs,
    };
  }

  /** Connects to the MCP server. Tries streamable-http, falls back to SSE on connect error. */
  async connect(url: string): Promise<void> {
    if (this.client && this.connectedUrl === url) return;
    if (this.client) {
      await this.close();
    }
    const parsed = new URL(url.endsWith('/') ? `${url}mcp` : `${url}/mcp`);

    const tryOnce = async (mode: 'http' | 'sse'): Promise<void> => {
      const client = this.deps.createClient();
      const transport =
        mode === 'http'
          ? this.deps.createStreamableTransport(parsed)
          : this.deps.createSseTransport(new URL(url.endsWith('/') ? `${url}sse` : `${url}/sse`));
      await withTimeout(client.connect(transport), this.deps.timeoutMs, `mcp_connect_${mode}`);
      this.client = client;
      this.connectedUrl = url;
    };

    try {
      await tryOnce('http');
      this.deps.log.info('mcp_bridge_connected', { url, transport: 'streamable-http' });
      return;
    } catch (errFirst) {
      const msg = (errFirst as Error).message;
      this.deps.log.warn('mcp_bridge_http_connect_failed', { url, err: msg });
    }

    // One retry over HTTP (transient network errors) before falling back.
    try {
      await tryOnce('http');
      this.deps.log.info('mcp_bridge_connected', { url, transport: 'streamable-http', attempt: 2 });
      return;
    } catch (errSecond) {
      const msg = (errSecond as Error).message;
      this.deps.log.warn('mcp_bridge_http_connect_retry_failed', { url, err: msg });
    }

    // SSE fallback.
    try {
      await tryOnce('sse');
      this.deps.log.info('mcp_bridge_connected', { url, transport: 'sse' });
    } catch (errSse) {
      this.client = null;
      this.connectedUrl = null;
      throw new Error(`mcp_connect_failed: ${(errSse as Error).message}`);
    }
  }

  /** Returns the cached Ollama tool list, refreshing on TTL expiry. */
  async listTools(): Promise<OllamaTool[]> {
    if (!this.client) throw new Error('mcp_not_connected');
    const now = this.deps.now();
    if (this.toolCache && this.toolCache.expiresAt > now) return this.toolCache.tools;
    try {
      const result = await withTimeout(this.client.listTools(), this.deps.timeoutMs, 'mcp_list_tools');
      const tools = Array.isArray(result.tools) ? result.tools.map(mcpToolToOllama) : [];
      this.toolCache = { tools, expiresAt: now + this.deps.toolCacheTtlMs };
      return tools;
    } catch (err) {
      this.deps.log.warn('mcp_bridge_list_tools_failed', { err: (err as Error).message });
      // Cache empty list briefly so callers don't hammer a broken server.
      this.toolCache = { tools: [], expiresAt: now + Math.min(this.deps.toolCacheTtlMs, 10_000) };
      return [];
    }
  }

  /**
   * Invokes a tool. Returns the joined text content. Never throws — errors
   * are converted to a human-readable error string so the model can recover.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) {
      return `error: mcp_not_connected (tool=${name})`;
    }
    try {
      const result = await withTimeout(
        this.client.callTool({ name, arguments: args }),
        this.deps.timeoutMs,
        `mcp_call_${name}`,
      );
      const text = stringifyToolContent(result.content, result.structuredContent);
      if (result.isError) return `tool_error: ${text}`;
      return text;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.deps.log.warn('mcp_bridge_call_tool_failed', { name, err: message });
      return `error: ${message}`;
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connectedUrl = null;
    this.toolCache = null;
    if (!client) return;
    try {
      await client.close();
    } catch (err) {
      this.deps.log.warn('mcp_bridge_close_error', { err: (err as Error).message });
    }
  }

  /** Test/diagnostics helper: true when a live client is held. */
  isConnected(): boolean {
    return this.client !== null;
  }
}

// region ---------- singleton helpers ----------

let singleton: McpBridge | null = null;
let singletonUrl: string | null = null;

/**
 * Returns a process-wide bridge instance, lazily connecting on first use.
 * If connection fails, returns null and the caller should proceed without tools.
 */
export const getOrConnectMcpBridge = async (
  url: string,
  log: McpBridgeLogger = fallbackLogger,
): Promise<McpBridge | null> => {
  if (singleton && singletonUrl === url && singleton.isConnected()) {
    return singleton;
  }
  if (singleton && singletonUrl !== url) {
    await singleton.close().catch(() => undefined);
    singleton = null;
    singletonUrl = null;
  }
  const bridge = singleton ?? new McpBridge({ log });
  try {
    await bridge.connect(url);
    singleton = bridge;
    singletonUrl = url;
    return bridge;
  } catch (err) {
    log.warn('mcp_bridge_singleton_connect_failed', { url, err: (err as Error).message });
    singleton = null;
    singletonUrl = null;
    return null;
  }
};

/** Reset the cached singleton (tests). */
export const resetMcpBridgeSingleton = async (): Promise<void> => {
  if (singleton) await singleton.close().catch(() => undefined);
  singleton = null;
  singletonUrl = null;
};

// endregion
