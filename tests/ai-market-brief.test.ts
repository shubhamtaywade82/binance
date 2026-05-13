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
        messages: expect.arrayContaining([
          { role: 'system', content: expect.stringContaining('market-structure') },
          { role: 'user', content: expect.stringContaining('SOLUSDT') },
        ]),
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

  it('falls back to message.thinking when content is blank', async () => {
    mockChat.mockResolvedValueOnce({
      message: { content: '', thinking: '## Analysis\nMarket is choppy.' },
      done_reason: 'stop',
      eval_count: 3,
    });
    const r = await requestMarketBrief({ ...baseCfg }, snapshot);
    expect(r.error).toBeNull();
    expect(r.text).toContain('choppy');
    expect(r.text).toContain('reasoning');
  });
});
