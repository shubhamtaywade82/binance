import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockChat, MockOllama } = vi.hoisted(() => {
  const mockChat = vi.fn();
  const MockOllama = vi.fn().mockImplementation(() => ({ chat: mockChat }));
  return { mockChat, MockOllama };
});

vi.mock('ollama', () => ({
  Ollama: MockOllama,
}));

import { requestMarketBrief } from '../src/ai/market-brief';

const baseCfg = {
  host: 'http://127.0.0.1:11434',
  model: 'llama3.2',
  timeoutMs: 5000,
} as const;

const snapshot = {
  symbol: 'SOLUSDT',
  refPrice: 142.5,
  htfBias: 'LONG',
  ltfDirection: 'LONG',
  ltfConfidence: 0.72,
  ltfScore: 4,
  smc: { score: 3, bos: 'LONG', choch: 'NONE' },
  solMtf: { pass: false, direction: 'LONG', reasons: ['1d filter weak'] },
};

describe('requestMarketBrief', () => {
  beforeEach(() => {
    mockChat.mockResolvedValue({
      message: { content: '- First line.\n- Second line.\nNot financial advice.' },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns trimmed assistant content from Ollama chat', async () => {
    const r = await requestMarketBrief({ ...baseCfg }, snapshot);
    expect(r.error).toBeNull();
    expect(r.text).toContain('First line');
    expect(r.thinking).toBeNull();
    expect(MockOllama).toHaveBeenCalledTimes(1);
    expect(MockOllama).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'http://127.0.0.1:11434',
        fetch: expect.any(Function),
      }),
    );
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'llama3.2',
        stream: false,
        think: false,
        messages: expect.arrayContaining([
          { role: 'system', content: expect.stringContaining('market-structure') },
          { role: 'user', content: expect.stringContaining('SOLUSDT') },
        ]),
        options: { temperature: 0.25, num_predict: 1024 },
      }),
    );
  });

  it('passes Authorization when apiKey is set', async () => {
    await requestMarketBrief({ ...baseCfg, apiKey: 'cloud-key' }, snapshot);
    expect(MockOllama).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Authorization: 'Bearer cloud-key' },
      }),
    );
  });

  it('returns error when model is blank', async () => {
    const r = await requestMarketBrief({ ...baseCfg, model: '   ' }, snapshot);
    expect(r.text).toBeNull();
    expect(r.thinking).toBeNull();
    expect(r.error).toBe('missing_ollama_model');
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('maps chat failures to error', async () => {
    mockChat.mockRejectedValueOnce(new Error('connection refused'));
    const r = await requestMarketBrief({ ...baseCfg }, snapshot);
    expect(r.text).toBeNull();
    expect(r.error).toBe('connection refused');
  });

  it('maps empty message content to diagnostic error', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: '   ' },
      done_reason: 'stop',
      eval_count: 0,
      model: 'llama3.2',
    });
    const r = await requestMarketBrief({ ...baseCfg }, snapshot);
    expect(r.text).toBeNull();
    expect(r.error).toMatch(/empty_completion/);
    expect(r.error).toContain('eval_count=0');
    expect(r.error).toContain('ollama list');
  });

  it('falls back to message.thinking when content is blank and think is off', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: '', thinking: '## Analysis\nMarket is choppy.' },
      done_reason: 'stop',
      eval_count: 3,
    });
    const r = await requestMarketBrief({ ...baseCfg }, snapshot);
    expect(r.error).toBeNull();
    expect(r.text).toContain('choppy');
    expect(r.text).toContain('AI_BRIEF_THINK_ENABLED');
    expect(r.thinking).toBeNull();
  });

  it('falls back to top-level thinking when message fields are blank', async () => {
    mockChat.mockResolvedValueOnce({
      message: { role: 'assistant', content: '' },
      thinking: 'Root-level reasoning only.',
      done_reason: 'stop',
      eval_count: 1,
    });
    const r = await requestMarketBrief({ ...baseCfg }, snapshot);
    expect(r.error).toBeNull();
    expect(r.text).toContain('Root-level reasoning');
    expect(r.thinking).toBeNull();
  });

  it('uses think true and exposes thinking when thinkEnabled', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: '## Brief\n\n- **Bias:** LONG.\n\n*Not financial advice.*', thinking: 'step 1…' },
      done_reason: 'stop',
      eval_count: 10,
      model: 'qwen3.5:4b',
    });
    const r = await requestMarketBrief({ ...baseCfg, thinkEnabled: true }, snapshot);
    expect(r.error).toBeNull();
    expect(r.text).toContain('Bias');
    expect(r.thinking).toContain('step 1');
    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({
        think: true,
        stream: false,
        messages: expect.arrayContaining([
          { role: 'system', content: expect.stringContaining('reasoning channel') },
        ]),
      }),
    );
  });

  it('streams and accumulates message deltas', async () => {
    async function* gen() {
      yield { message: { content: '', thinking: 'A' }, done: false };
      yield { message: { content: '## B', thinking: '' }, done: false };
      yield { message: { content: 'rief\n', thinking: '' }, done: false };
      yield {
        message: { content: '\n*Not financial advice.*', thinking: '' },
        done: true,
        done_reason: 'stop',
        eval_count: 4,
        model: 'm',
      };
    }
    mockChat.mockResolvedValueOnce(gen());
    const chunks: Array<{ content: string; thinking: string }> = [];
    const r = await requestMarketBrief(
      {
        ...baseCfg,
        streamEnabled: true,
        onStreamChunk: (c) => chunks.push({ content: c.content, thinking: c.thinking }),
      },
      snapshot,
    );
    expect(r.error).toBeNull();
    expect(r.text).toContain('## Brief');
    expect(mockChat).toHaveBeenCalledWith(expect.objectContaining({ stream: true, think: false }));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[chunks.length - 1]?.thinking).toBe('A');
  });
});
